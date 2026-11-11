import type { AppConfig } from "../config.js";
import { DailyLossBook } from "../daily-loss.js";
import type { Logger } from "../logger.js";
import { EquityBook, positionValueSol } from "../momentum/equity.js";
import type { MomentumMarket } from "../momentum/market.js";
import { ATA_RENT_SOL, momentumPaperBuy, momentumPaperSell, reservesFromPair, swapFeeBps } from "../momentum/paper.js";
import { liveAvailableSol, momentumFees, momentumSize, momentumSlippagePct } from "../momentum/rules.js";
import { SolCrashGuard } from "../momentum/sol-crash.js";
import type { PaperBalance } from "../paper-balance.js";
import type { PositionBook } from "../positions.js";
import { TOTAL_SUPPLY_TOKENS } from "../pricing.js";
import { berlinDay, type TradeLog } from "../report.js";
import type { Executor, MarketLaunch, MarketTrade, Position, TradeReason } from "../types.js";
import type { ScalpGateFacts } from "./rules.js";
import { SCALP, scalpExecutionFee, scalpExit, scalpGate, scalpLargeBuys, scalpRemainderNetSol, scalpRoundTripCost, scalpSpike, scalpWarmInterest, type ScalpPrint } from "./rules.js";
import { bundledInsiderPct } from "../momentum/rules.js";
import { WSOL_MINT } from "../pricing.js";

export interface ScalpHint {
  ageMs: number | null;
  liquidityUsd: number | null;
  bundlePct: number | null;
  creator: string | null;
}

export interface ScalpDeps {
  config: AppConfig;
  executor: Executor;
  positions: PositionBook;
  trades: TradeLog;
  log: Logger;
  solUsd: () => number | null;
  solLast?: () => { price: number | null; atMs: number | null };
  now: () => Date;
  market: MomentumMarket;
  paperBalance?: PaperBalance;
  walletBalanceSol?: () => Promise<number>;
  reclaimRent?: (mint: string) => Promise<{ closed: boolean; rentSol: number; reason: string }>;
  gate: (mint: string, hint: ScalpHint) => Promise<ScalpGateFacts | "timeout">;
  /** Paper only. Starts the safety reads before the entry spike. */
  prewarm?: (mint: string, hint: ScalpHint) => void;
  /** Local trade subscription. The Helius program feed filters to these mints. */
  watch?: (mint: string) => void;
  daily?: DailyLossBook;
}

interface LaunchMemory {
  atMs: number;
  creator: string;
  slot: number | null;
  buys: { slot: number; trader: string; tokens: number }[];
  incomplete: boolean;
}

/**
 * Spike detection runs on each trade print. A 6% rise or the first large
 * buy starts the safety reads. The gate itself runs after a full spike.
 */
export class ScalpRunner {
  private readonly watched = new Set<string>();
  private readonly prints = new Map<string, ScalpPrint[]>();
  private readonly launches = new Map<string, LaunchMemory>();
  private readonly gating = new Set<string>();
  private readonly selling = new Set<string>();
  /** Mint whose ATA stays open until this time, waiting for a re-entry. */
  private readonly ataUntil = new Map<string, number>();
  private readonly daily: DailyLossBook;
  private readonly equity: EquityBook;
  private readonly solCrash: SolCrashGuard;
  private killLogged = false;

  constructor(private readonly deps: ScalpDeps) {
    this.daily = deps.daily ?? new DailyLossBook(`${deps.config.dataDir}/daily-pnl.json`);
    this.equity = new EquityBook(`${deps.config.dataDir}/equity-hwm.json`, deps.config.killFile);
    this.solCrash = new SolCrashGuard(`${deps.config.dataDir}/sol-crash.json`);
  }

  noteLaunch(event: MarketLaunch): void {
    const prior = this.launches.get(event.mint);
    this.launches.set(event.mint, {
      atMs: prior?.atMs ?? this.deps.now().getTime(),
      creator: event.creator,
      slot: event.slot ?? prior?.slot ?? null,
      buys: prior?.buys ?? [],
      incomplete: prior?.incomplete ?? false,
    });
    this.watch(event.mint);
  }

  /** A mint found on DexScreener or the launch feed. Later prints are eligible. */
  watch(mint: string): void {
    if (this.watched.has(mint)) return;
    this.watched.add(mint);
    this.deps.watch?.(mint);
    this.deps.log.info("scalp", { mint, decision: "watch", reason: "candidate" });
  }

  /** DexScreener boosted and profiled Solana mints, plus anything already watched. */
  async discover(): Promise<void> {
    try {
      const mints = await this.deps.market.candidates();
      for (const mint of mints) this.watch(mint);
    } catch (error) {
      this.deps.log.info("scalp", {
        decision: "skip",
        reason: "discovery_unavailable",
        error: error instanceof Error ? error.message : "market",
      });
    }
  }

  noteTrade(event: MarketTrade): void {
    if (!(event.priceSol != null && event.priceSol > 0)) return;
    if (!this.watched.has(event.mint) && this.deps.positions.get(event.mint)?.strategy !== "scalp") return;
    const memory = this.launches.get(event.mint);
    if (memory && event.txType === "buy" && memory.slot != null && event.slot != null) {
      if (event.slot >= memory.slot && event.slot <= memory.slot + 2 && event.trader !== memory.creator) {
        const tokens = event.solAmount != null && event.priceSol > 0 ? event.solAmount / event.priceSol : null;
        if (tokens == null) memory.incomplete = true;
        else memory.buys.push({ slot: event.slot, trader: event.trader, tokens });
      }
    }
    const row: ScalpPrint = {
      atMs: this.deps.now().getTime(),
      priceSol: event.priceSol,
      side: event.txType,
      solAmount: event.solAmount ?? null,
    };
    const tape = this.prints.get(event.mint) ?? [];
    tape.push(row);
    const keepMs = Math.max(SCALP.windowMs * 2, this.deps.config.scalpLargeBuyWindowSec * 1000);
    const cutoff = row.atMs - keepMs;
    this.prints.set(event.mint, tape.filter((print) => print.atMs >= cutoff));
    const position = this.deps.positions.get(event.mint);
    if (position?.strategy === "scalp") {
      void this.mark(position, event.priceSol, event);
      return;
    }
    void this.maybeEnter(event, row.atMs);
  }

  /** Time exits still run when the mint goes quiet. */
  checkClocks(): void {
    const nowMs = this.deps.now().getTime();
    for (const [mint, until] of this.ataUntil) {
      if (until > nowMs || this.deps.positions.get(mint)) continue;
      this.ataUntil.delete(mint);
      if (this.deps.config.mode === "paper") {
        this.deps.paperBalance?.add(ATA_RENT_SOL - this.deps.config.paper.baseFeeSol);
        this.deps.log.info("rent reclaimed", { mint, rentSol: ATA_RENT_SOL, reason: "ata_reuse_expired" });
      } else if (this.deps.reclaimRent) {
        void this.deps.reclaimRent(mint).then((rent) => {
          this.deps.log.info("rent reclaimed", { mint, rentSol: rent.rentSol, closed: rent.closed, reason: "ata_reuse_expired" });
        });
      }
    }
    for (const position of this.deps.positions.list()) {
      if (position.strategy !== "scalp" || !(position.lastMarkPriceSol > 0)) continue;
      void this.mark(position, position.lastMarkPriceSol, null, nowMs);
    }
  }

  async tick(): Promise<void> {
    await this.discover();
    this.checkClocks();
    await this.markEquity();
    const nowMs = this.deps.now().getTime();
    const last = this.deps.solLast?.() ?? { price: this.deps.solUsd(), atMs: this.deps.solUsd() == null ? null : nowMs };
    const pause = this.solCrash.observe(last.price, last.atMs, nowMs);
    if (pause.kind === "start" || pause.kind === "extend" || pause.kind === "end") {
      this.deps.log.info("sol_crash_pause", { state: pause.kind, until: new Date(pause.pauseUntilMs).toISOString() });
    }
    if (pause.kind === "stale") this.deps.log.info("sol_price_stale", { blocked: false });
    if (this.equity.killed() && !this.killLogged) {
      this.killLogged = true;
      this.deps.log.info("kill_switch", { reason: this.equity.killReason()?.reason ?? "drawdown" });
    }
  }

  private async maybeEnter(event: MarketTrade, nowMs: number): Promise<void> {
    if (this.gating.has(event.mint) || this.deps.positions.get(event.mint)) return;
    if (this.deps.positions.list().length >= this.deps.config.maxOpenPositions) {
      this.deps.log.info("scalp", { mint: event.mint, decision: "skip", reason: "max_open_positions" });
      return;
    }
    if (this.blocked()) {
      this.deps.log.info("scalp", { mint: event.mint, decision: "skip", reason: "entries_blocked" });
      return;
    }
    this.warm(event, nowMs);
    const spike = scalpSpike(this.prints.get(event.mint) ?? [], nowMs, {
      minPct: this.deps.config.scalpSpikeMinPct,
      maxPct: this.deps.config.scalpSpikeMaxPct,
    });
    this.deps.log.info("scalp", { mint: event.mint, decision: spike.ok ? "spike" : "skip", reason: spike.reason, risePct: spike.risePct, buys: spike.buys });
    if (!spike.ok) return;
    const solUsd = this.deps.solUsd();
    if (!(solUsd != null && solUsd > 0)) {
      this.deps.log.info("scalp", { mint: event.mint, decision: "skip", reason: "no_price" });
      return;
    }
    const large = scalpLargeBuys(this.prints.get(event.mint) ?? [], nowMs, {
      windowMs: this.deps.config.scalpLargeBuyWindowSec * 1000,
      minUsd: this.deps.config.scalpLargeBuyUsd,
      minSol: this.deps.config.scalpLargeBuySol,
      minCount: this.deps.config.scalpMinLargeBuys,
      solUsd,
    });
    this.deps.log.info("scalp", {
      mint: event.mint,
      decision: large.ok ? "large_buys" : "skip",
      reason: large.ok ? "large_buys" : "no_large_buyers",
      count: large.buys.length,
      sizes: large.buys,
    });
    if (!large.ok) return;
    this.gating.add(event.mint);
    try {
      const memory = this.launches.get(event.mint);
      const liquidityUsd = this.liquidityUsd(event, solUsd);
      const bundlePct = memory?.incomplete
        ? null
        : bundledInsiderPct({
            supplyTokens: TOTAL_SUPPLY_TOKENS,
            createSlot: memory?.slot ?? null,
            creator: memory?.creator ?? null,
            buys: memory?.buys ?? [],
          });
      const gated = await this.deps.gate(event.mint, {
        ageMs: memory ? nowMs - memory.atMs : null,
        liquidityUsd,
        bundlePct,
        creator: memory?.creator ?? null,
      });
      if (gated === "timeout") {
        this.deps.log.info("scalp", { mint: event.mint, decision: "skip", reason: "gate_timeout" });
        return;
      }
      const decision = scalpGate(gated);
      this.deps.log.info("scalp", { mint: event.mint, decision: decision.ok ? "buy" : "skip", reason: decision.reason });
      if (!decision.ok) return;
      await this.buy(event, solUsd, gated.liquidityUsd ?? liquidityUsd ?? 0, memory?.creator ?? "");
    } finally {
      this.gating.delete(event.mint);
    }
  }

  private async buy(event: MarketTrade, solUsd: number, liquidityUsd: number, creator: string): Promise<void> {
    const available = await this.available(solUsd);
    const sized = momentumSize({
      availableSol: available,
      solUsd,
      sizePct: this.deps.config.momentumSizePct,
      maxUsd: this.deps.config.momentumMaxUsd,
    });
    if (!sized.ok) {
      this.deps.log.info("scalp", { mint: event.mint, decision: "skip", reason: sized.reason });
      return;
    }
    const fees = momentumFees(this.deps.config, true);
    const paid = scalpExecutionFee(this.deps.config.scalpPriorityFeeSol, fees.tipSol);
    const pool = event.venue === "pumpswap" ? "pump-amm" as const : "pump" as const;
    const reserves = reservesFromPair(event.poolBaseTokens ?? null, event.poolQuoteSol ?? null, event.venue === "pumpswap" ? WSOL_MINT : null)
      ?? (event.vTokens != null && event.vSolSol != null ? { baseTokens: event.vTokens, quoteSol: event.vSolSol } : null);
    const feeBps = swapFeeBps(this.deps.config, pool === "pump" ? "pump" : "pumpswap");
    const trip = scalpRoundTripCost({
      sizeSol: sized.sizeSol,
      reserves,
      feeBps,
      baseFeeSol: this.deps.config.paper.baseFeeSol,
      txFeeSol: paid.priorityFeeSol + paid.tipSol,
    });
    if (!trip || trip.costPct * 100 > this.deps.config.scalpMaxCostPct) {
      this.deps.log.info("scalp", {
        mint: event.mint,
        decision: "skip",
        reason: "fee_drag",
        costSol: trip?.costSol ?? null,
        costPct: trip ? trip.costPct * 100 : null,
        maxPct: this.deps.config.scalpMaxCostPct,
      });
      return;
    }
    const reuseAta = (this.ataUntil.get(event.mint) ?? 0) > this.deps.now().getTime();
    if (reuseAta) this.ataUntil.delete(event.mint);
    const rentSol = reuseAta ? 0 : ATA_RENT_SOL;
    if (!(available >= sized.sizeSol + paid.priorityFeeSol + this.deps.config.paper.baseFeeSol + paid.tipSol + rentSol)) {
      this.deps.log.info("scalp", { mint: event.mint, decision: "skip", reason: "insufficient_balance" });
      return;
    }
    const mcapUsd = event.marketCapSol != null ? event.marketCapSol * solUsd : liquidityUsd;
    const slippagePct = momentumSlippagePct(mcapUsd);
    const quote = event.priceSol ?? 0;
    let fill;
    let costs;
    if (this.deps.config.mode === "paper") {
      const paper = momentumPaperBuy({
        sizeSol: sized.sizeSol,
        slippagePct,
        reserves,
        feeBps,
        baseFeeSol: this.deps.config.paper.baseFeeSol,
        priorityFeeSol: paid.priorityFeeSol,
        tipSol: paid.tipSol,
        includeRent: !reuseAta,
      });
      fill = paper.fill;
      costs = paper.costs;
    } else {
      fill = await this.deps.executor.buy({
        mint: event.mint,
        name: event.mint.slice(0, 4),
        symbol: "",
        creator,
        sizeSol: sized.sizeSol,
        quotePriceSol: quote,
        slippagePct,
        reason: "entry",
        pool,
        tipSol: paid.tipSol,
        priorityFeeSol: paid.priorityFeeSol,
        useJito: fees.useJito,
        mevRequired: true,
        useQuotedSlippage: true,
      });
    }
    this.deps.trades.append({
      timestamp: this.deps.now().toISOString(),
      mode: this.deps.config.mode,
      side: "buy",
      status: fill.status,
      mint: event.mint,
      name: event.mint.slice(0, 4),
      symbol: "",
      sizeSol: fill.status === "filled" ? fill.sizeSol : sized.sizeSol,
      sizeUsd: sized.sizeUsd,
      price: fill.price,
      feesSol: fill.feesSol,
      jitoTipSol: fill.jitoTipSol,
      signature: fill.signature || (this.deps.config.mode === "paper" ? "paper" : ""),
      solscan: fill.solscan,
      reason: "entry",
      error: fill.error,
      solUsd,
      tokenAmount: fill.tokenAmount,
      realizedPnlSol: null,
      costSol: fill.status === "filled" ? fill.cashflowSol : null,
      strategy: "scalp",
      bundle: fees.useJito ? "jito" : null,
      ...(costs ? { costs } : {}),
    });
    if (fill.status !== "filled" || !(quote > 0)) return;
    if (this.deps.config.mode === "paper") this.deps.paperBalance?.add(-fill.cashflowSol);
    const position: Position = {
      mint: event.mint,
      name: event.mint.slice(0, 4),
      symbol: "",
      creator,
      tokenAmount: fill.tokenAmount,
      entryPriceSol: fill.price,
      costSol: fill.cashflowSol,
      feesSol: fill.feesSol,
      tipSol: fill.jitoTipSol,
      openedAt: this.deps.now().toISOString(),
      mode: this.deps.config.mode,
      entrySignature: fill.signature,
      lastMarkPriceSol: quote,
      peakPriceSol: quote,
      strategy: "scalp",
      momentumPool: pool,
      graduated: pool === "pump-amm",
      scalpTpTaken: false,
      scalpCostPct: trip.costPct,
      lastVSolSol: event.vSolSol,
      lastVTokens: event.vTokens,
      poolBaseTokens: event.poolBaseTokens,
      poolQuoteSol: event.poolQuoteSol,
    };
    this.deps.positions.open(position);
  }

  private async mark(position: Position, priceSol: number, event: MarketTrade | null, nowMs = this.deps.now().getTime()): Promise<void> {
    if (this.selling.has(position.mint)) return;
    const current = this.deps.positions.get(position.mint);
    if (!current) return;
    current.lastMarkPriceSol = priceSol;
    current.peakPriceSol = Math.max(current.peakPriceSol ?? priceSol, priceSol);
    const feeBps = swapFeeBps(this.deps.config, current.momentumPool === "pump" ? "pump" : "pumpswap");
    const paid = scalpExecutionFee(this.deps.config.scalpPriorityFeeSol, momentumFees(this.deps.config, true).tipSol);
    const remainder = scalpRemainderNetSol({
      tokenAmount: current.scalpTpTaken ? current.tokenAmount / (1 - SCALP.tpOfOriginal) : current.tokenAmount,
      priceSol,
      feeBps,
      baseFeeSol: this.deps.config.paper.baseFeeSol,
      txFeeSol: paid.priorityFeeSol + paid.tipSol,
    });
    const exit = scalpExit({
      entryPriceSol: current.entryPriceSol,
      peakPriceSol: current.peakPriceSol,
      priceSol,
      tpTaken: current.scalpTpTaken === true,
      openedAtMs: Date.parse(current.openedAt),
      nowMs,
      maxHoldMs: this.deps.config.scalpMaxHoldMin * 60 * 1000,
      costPct: current.scalpCostPct ?? 0,
      sellAll: remainder < this.deps.config.scalpMinRemainderSol,
    });
    if (!exit) return;
    await this.sell(current, exit.reason, exit.sellFraction, priceSol, event);
  }

  private async sell(position: Position, reason: TradeReason, fraction: number, quote: number, event: MarketTrade | null): Promise<void> {
    this.selling.add(position.mint);
    try {
      const current = this.deps.positions.get(position.mint);
      if (!current) return;
      const before = current.tokenAmount;
      const portion = Math.min(1, Math.max(0, fraction));
      const requested = portion >= 0.999 ? before : before * portion;
      const closing = portion >= 0.999;
      const fees = momentumFees(this.deps.config, true);
      const paid = scalpExecutionFee(this.deps.config.scalpPriorityFeeSol, fees.tipSol);
      if (closing) this.ataUntil.set(current.mint, this.deps.now().getTime() + SCALP.ataReuseMs);
      const solUsd = this.deps.solUsd();
      const mcapUsd = event?.marketCapSol != null && solUsd != null ? event.marketCapSol * solUsd : 0;
      const slippagePct = momentumSlippagePct(mcapUsd || this.deps.config.momentumMaxUsd);
      let fill;
      let costs;
      const reserves = event
        ? reservesFromPair(event.poolBaseTokens ?? null, event.poolQuoteSol ?? null, WSOL_MINT)
          ?? (event.vTokens != null && event.vSolSol != null ? { baseTokens: event.vTokens, quoteSol: event.vSolSol } : null)
        : current.poolBaseTokens != null && current.poolQuoteSol != null
          ? { baseTokens: current.poolBaseTokens, quoteSol: current.poolQuoteSol }
          : current.lastVTokens != null && current.lastVSolSol != null
            ? { baseTokens: current.lastVTokens, quoteSol: current.lastVSolSol }
            : null;
      if (this.deps.config.mode === "paper") {
        const paper = momentumPaperSell({
          tokenAmount: requested,
          slippagePct,
          reserves,
          feeBps: swapFeeBps(this.deps.config, current.momentumPool === "pump" ? "pump" : "pumpswap"),
          baseFeeSol: this.deps.config.paper.baseFeeSol,
          priorityFeeSol: paid.priorityFeeSol,
          tipSol: paid.tipSol,
          closeAccount: false,
        });
        fill = paper.fill;
        costs = paper.costs;
      } else {
        fill = await this.deps.executor.sell({
          mint: current.mint,
          name: current.name,
          symbol: current.symbol,
          creator: current.creator,
          sizeSol: current.costSol,
          quotePriceSol: quote,
          slippagePct,
          reason,
          tokenAmount: requested,
          sellFraction: portion,
          pool: current.momentumPool ?? "pump",
          tipSol: paid.tipSol,
          priorityFeeSol: paid.priorityFeeSol,
          useJito: fees.useJito,
          mevRequired: true,
        });
      }
      const sold = Math.min(before, fill.tokenAmount > 0 ? fill.tokenAmount : requested);
      const share = before > 0 ? sold / before : 1;
      const costAllocated = current.costSol * share;
      const realized = fill.status === "filled" ? fill.cashflowSol - costAllocated : null;
      this.deps.trades.append({
        timestamp: this.deps.now().toISOString(),
        mode: this.deps.config.mode,
        side: "sell",
        status: fill.status,
        mint: current.mint,
        name: current.name,
        symbol: current.symbol,
        sizeSol: fill.status === "filled" ? fill.sizeSol : 0,
        price: fill.price,
        feesSol: fill.feesSol,
        jitoTipSol: fill.jitoTipSol,
        signature: fill.signature || (this.deps.config.mode === "paper" ? "paper" : ""),
        solscan: fill.solscan,
        reason,
        error: fill.error,
        solUsd,
        tokenAmount: fill.status === "filled" ? sold : requested,
        realizedPnlSol: realized,
        costSol: fill.status === "filled" ? costAllocated : current.costSol,
        triggerPriceSol: quote,
        strategy: "scalp",
        bundle: fees.useJito ? "jito" : null,
        ...(costs ? { costs } : {}),
      });
      if (fill.status !== "filled") return;
      if (this.deps.config.mode === "paper") this.deps.paperBalance?.add(fill.cashflowSol);
      if (realized != null && this.deps.config.maxDailyLossSol != null) {
        this.daily.add(this.deps.config.mode, berlinDay(this.deps.now().toISOString()), realized);
      }
      const remaining = before - sold;
      if (remaining > 1e-9 && share < 0.999) {
        current.tokenAmount = remaining;
        current.costSol -= costAllocated;
        if (reason === "scalp_tp") current.scalpTpTaken = true;
        if (event?.vSolSol != null) current.lastVSolSol = event.vSolSol;
        if (event?.vTokens != null) current.lastVTokens = event.vTokens;
        return;
      }
      this.deps.positions.close(current.mint);
    } finally {
      this.selling.delete(position.mint);
    }
  }

  /** Paper runs start the sell sim before the spike is complete. */
  private warm(event: MarketTrade, nowMs: number): void {
    if (this.deps.config.mode !== "paper" || !this.deps.prewarm) return;
    const prints = this.prints.get(event.mint) ?? [];
    const solUsd = this.deps.solUsd();
    if (!scalpWarmInterest(prints, nowMs, {
      windowMs: this.deps.config.scalpLargeBuyWindowSec * 1000,
      minUsd: this.deps.config.scalpLargeBuyUsd,
      minSol: this.deps.config.scalpLargeBuySol,
      solUsd,
    })) return;
    const memory = this.launches.get(event.mint);
    this.deps.prewarm(event.mint, {
      ageMs: memory ? nowMs - memory.atMs : null,
      liquidityUsd: solUsd != null && solUsd > 0 ? this.liquidityUsd(event, solUsd) : null,
      bundlePct: memory?.incomplete
        ? null
        : bundledInsiderPct({
            supplyTokens: TOTAL_SUPPLY_TOKENS,
            createSlot: memory?.slot ?? null,
            creator: memory?.creator ?? null,
            buys: memory?.buys ?? [],
          }),
      creator: memory?.creator ?? null,
    });
  }

  private liquidityUsd(event: MarketTrade, solUsd: number): number | null {
    if (event.venue === "pumpswap" && event.poolQuoteSol != null && event.poolQuoteSol > 0) return event.poolQuoteSol * solUsd * 2;
    if (event.vSolSol != null && event.vSolSol > 0) return event.vSolSol * solUsd * 2;
    return null;
  }

  private blocked(): boolean {
    if (this.equity.killed()) return true;
    if (this.solCrash.blocksBuys(this.deps.now().getTime())) return true;
    const max = this.deps.config.maxDailyLossSol;
    if (max == null) return false;
    return this.daily.realized(this.deps.config.mode, berlinDay(this.deps.now().toISOString())) <= -max;
  }

  private async available(solUsd: number): Promise<number> {
    if (this.deps.config.mode === "paper") return this.deps.paperBalance?.cash() ?? 0;
    const wallet = this.deps.walletBalanceSol ? await this.deps.walletBalanceSol() : 0;
    return liveAvailableSol(wallet, this.deps.config.gasReserveUsd, solUsd);
  }

  private async markEquity(): Promise<void> {
    const solUsd = this.deps.solUsd();
    if (!(solUsd != null && solUsd > 0)) return;
    const cash = this.deps.config.mode === "paper"
      ? (this.deps.paperBalance?.cash() ?? 0)
      : this.deps.walletBalanceSol
        ? await this.deps.walletBalanceSol()
        : 0;
    const reserve = this.deps.config.mode === "paper" ? this.deps.config.gasReserveUsd / solUsd : 0;
    let marked = 0;
    for (const position of this.deps.positions.list()) {
      marked += positionValueSol(position.tokenAmount, position.lastMarkPriceSol, 25, this.deps.config.paper.baseFeeSol, this.deps.config.scalpPriorityFeeSol);
    }
    this.equity.mark(cash + reserve + marked, this.deps.now().toISOString());
  }
}
