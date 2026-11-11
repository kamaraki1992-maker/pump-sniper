import type { AppConfig } from "../config.js";
import { DailyLossBook } from "../daily-loss.js";
import { tipForTrade } from "../tip.js";
import type { Logger } from "../logger.js";
import type { PaperBalance } from "../paper-balance.js";
import type { PositionBook } from "../positions.js";
import { TOTAL_SUPPLY_TOKENS } from "../pricing.js";
import { berlinDay, type TradeLog } from "../report.js";
import type { Executor, MarketGraduation, MarketLaunch, MarketTrade, Position, TradeReason } from "../types.js";
import type { ChainFacts } from "./chain.js";
import type { DexPair, MomentumMarket } from "./market.js";
import {
  bundledInsiderPct,
  evaluateMomentum,
  momentumExit,
  momentumPool,
  momentumSize,
  momentumSlippagePct,
  turboFees,
  type Candle,
  type EarlyBuy,
  type MomentumFacts,
} from "./rules.js";

const PER_TICK = 8;

interface LaunchMemory {
  creator: string;
  slot: number | null;
  buys: EarlyBuy[];
  /** A buy in the bundle window arrived without a token amount. */
  incomplete: boolean;
}

export interface MomentumDeps {
  config: AppConfig;
  executor: Executor;
  positions: PositionBook;
  trades: TradeLog;
  log: Logger;
  solUsd: () => number | null;
  now: () => Date;
  market: MomentumMarket;
  chain: (mint: string, creator: string | null) => Promise<ChainFacts>;
  paperBalance?: PaperBalance;
  walletBalanceSol?: () => Promise<number>;
  daily?: DailyLossBook;
}

/**
 * Polls graduated pump.fun candidates and applies the momentum rules.
 * Sniper exits are not consulted. Paper and live share this loop; live
 * orders still go through the existing executor.
 */
export class MomentumRunner {
  private readonly launches = new Map<string, LaunchMemory>();
  private readonly graduated = new Set<string>();
  private queue: string[] = [];
  private readonly selling = new Set<string>();
  private readonly daily: DailyLossBook;

  constructor(private readonly deps: MomentumDeps) {
    this.daily = deps.daily ?? new DailyLossBook(`${deps.config.dataDir}/daily-pnl.json`);
  }

  noteLaunch(event: MarketLaunch): void {
    const prior = this.launches.get(event.mint);
    this.launches.set(event.mint, {
      creator: event.creator,
      slot: event.slot ?? prior?.slot ?? null,
      buys: prior?.buys ?? [],
      incomplete: prior?.incomplete ?? false,
    });
  }

  noteTrade(event: MarketTrade): void {
    if (event.txType !== "buy") return;
    const memory = this.launches.get(event.mint);
    if (!memory || memory.slot == null || event.slot == null) return;
    if (event.slot < memory.slot || event.slot > memory.slot + 2) return;
    if (event.trader === memory.creator) return;
    const tokens =
      event.solAmount != null && event.priceSol != null && event.priceSol > 0 ? event.solAmount / event.priceSol : null;
    if (tokens == null) {
      memory.incomplete = true;
      return;
    }
    memory.buys.push({ slot: event.slot, trader: event.trader, tokens });
  }

  noteGraduation(event: MarketGraduation): void {
    this.graduated.add(event.mint);
    if (!this.queue.includes(event.mint)) this.queue.push(event.mint);
  }

  async tick(): Promise<void> {
    await this.manageExits();
    if (this.entriesHalted()) {
      this.deps.log.info("momentum", { decision: "hold", reason: "daily_stop" });
      return;
    }
    await this.enqueue();
    const batch = this.queue.splice(0, PER_TICK);
    for (const mint of batch) {
      if (this.deps.positions.get(mint)?.momentum) continue;
      if (this.deps.positions.list().length >= this.deps.config.maxOpenPositions) {
        this.deps.log.info("momentum", { mint, decision: "hold", reason: "max_open_positions" });
        continue;
      }
      await this.consider(mint);
    }
  }

  private async enqueue(): Promise<void> {
    let remote: string[] = [];
    try {
      remote = await this.deps.market.candidates();
    } catch (error) {
      this.deps.log.info("momentum", {
        decision: "hold",
        reason: "candidates_unavailable",
        error: error instanceof Error ? error.message : "market",
      });
    }
    const seen = new Set(this.queue);
    for (const mint of [...this.graduated, ...remote]) {
      if (seen.has(mint) || this.deps.positions.get(mint)) continue;
      this.queue.push(mint);
      seen.add(mint);
    }
  }

  private async consider(mint: string): Promise<void> {
    const solUsd = this.deps.solUsd();
    if (!(solUsd != null && solUsd > 0)) {
      this.logDecision(mint, "hold", "no_price", null);
      return;
    }
    let pair: DexPair | null;
    try {
      pair = await this.deps.market.pair(mint);
    } catch (error) {
      this.logDecision(mint, "hold", "pair_unavailable", null, { error: error instanceof Error ? error.message : "market" });
      return;
    }
    if (!pair || !momentumPool(pair.dexId)) {
      this.logDecision(mint, "hold", "not_pump_pool", null);
      return;
    }
    const nowMs = this.deps.now().getTime();
    const memory = this.launches.get(mint);
    let candles: Candle[] = [];
    let trades = null as Awaited<ReturnType<MomentumMarket["trades"]>>;
    try {
      [candles, trades] = await Promise.all([
        this.deps.market.candles(pair.pairAddress, nowMs),
        this.deps.market.trades(pair.pairAddress, nowMs),
      ]);
    } catch (error) {
      this.logDecision(mint, "hold", "candles_unavailable", null, {
        error: error instanceof Error ? error.message : "market",
      });
      return;
    }
    const chain = await this.deps.chain(mint, memory?.creator ?? null);
    const facts = this.facts(pair, candles, trades, chain, nowMs);
    const decision = evaluateMomentum(facts);
    this.logDecision(mint, decision.action, decision.reason, decision.confidence, {
      mcap: pair.marketCapUsd,
      liq: pair.liquidityUsd,
    });
    if (decision.action !== "buy" || decision.confidence == null) return;
    await this.buy(pair, facts, decision.confidence, solUsd);
  }

  private facts(
    pair: DexPair,
    candles: Candle[],
    trades: Awaited<ReturnType<MomentumMarket["trades"]>>,
    chain: ChainFacts,
    nowMs: number,
  ): MomentumFacts {
    const memory = this.launches.get(pair.mint);
    const bundlePct = memory?.incomplete
      ? null
      : bundledInsiderPct({
          supplyTokens: TOTAL_SUPPLY_TOKENS,
          createSlot: memory?.slot ?? null,
          creator: memory?.creator ?? null,
          buys: memory?.buys ?? [],
        });
    return {
      nowMs,
      liquidityUsd: pair.liquidityUsd,
      dexId: pair.dexId,
      sawGraduation: this.graduated.has(pair.mint),
      top10Pct: chain.top10Pct,
      devPct: chain.devPct,
      bundlePct,
      pairCreatedAtMs: pair.pairCreatedAtMs,
      marketCapUsd: pair.marketCapUsd,
      volume5mUsd: pair.volume5mUsd,
      buys5m: pair.buys5m,
      sells5m: pair.sells5m,
      makers1h: trades?.makers1h ?? null,
      makersComplete: trades?.makersComplete ?? false,
      price: pair.priceUsd,
      candles,
      resistanceCandles: this.deps.config.momentumResistanceCandles,
      mintOk: chain.mintOk,
      mintReason: chain.mintReason,
      sellVolume15mUsd: trades?.sellVolume15mUsd ?? null,
      buyVolume15mUsd: trades?.buyVolume15mUsd ?? null,
      volume15mComplete: trades?.volume15mComplete ?? false,
    };
  }

  private async buy(pair: DexPair, facts: MomentumFacts, confidence: number, solUsd: number): Promise<void> {
    const parts = await this.balance();
    const sized = momentumSize({ balanceSol: parts.balanceSol, solUsd, confidence });
    if (!sized.ok) {
      this.logDecision(pair.mint, "hold", sized.reason, confidence);
      return;
    }
    const turbo = turboFees(this.deps.config);
    const overhead = turbo.priorityFeeSol + this.deps.config.paper.baseFeeSol + turbo.tipSol;
    if (!(parts.freeSol >= sized.sizeSol + overhead)) {
      this.logDecision(pair.mint, "hold", "insufficient_balance", confidence);
      return;
    }
    const pool = momentumPool(pair.dexId);
    if (!pool) return;
    const quotePriceSol = pair.priceUsd / solUsd;
    const memory = this.launches.get(pair.mint);
    const fill = await this.deps.executor.buy({
      mint: pair.mint,
      name: pair.name,
      symbol: pair.symbol,
      creator: memory?.creator ?? "",
      sizeSol: sized.sizeSol,
      quotePriceSol,
      slippagePct: momentumSlippagePct(pair.marketCapUsd),
      reason: "entry",
      pool,
      tipSol: turbo.tipSol,
      priorityFeeSol: turbo.priorityFeeSol,
      useQuotedSlippage: true,
    });
    this.deps.trades.append({
      timestamp: this.deps.now().toISOString(),
      mode: this.deps.config.mode,
      side: "buy",
      status: fill.status,
      mint: pair.mint,
      name: pair.name,
      symbol: pair.symbol,
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
      confidence: confidence / 100,
      entryScore: confidence,
    });
    if (fill.status !== "filled") return;
    if (this.deps.config.mode === "paper") this.deps.paperBalance?.add(-fill.cashflowSol);
    const position: Position = {
      mint: pair.mint,
      name: pair.name,
      symbol: pair.symbol,
      creator: memory?.creator ?? "",
      tokenAmount: fill.tokenAmount,
      entryPriceSol: fill.price,
      costSol: fill.cashflowSol,
      feesSol: fill.feesSol,
      tipSol: fill.jitoTipSol,
      openedAt: this.deps.now().toISOString(),
      mode: this.deps.config.mode,
      entrySignature: fill.signature,
      lastMarkPriceSol: quotePriceSol,
      peakPriceSol: quotePriceSol,
      momentum: true,
      momentumOriginalTokens: fill.tokenAmount,
      momentumTp1Taken: false,
      momentumTp2Taken: false,
      momentumPool: pool,
      graduated: true,
    };
    this.deps.positions.open(position);
  }

  private async manageExits(): Promise<void> {
    for (const position of this.deps.positions.list()) {
      if (!position.momentum || this.selling.has(position.mint)) continue;
      const solUsd = this.deps.solUsd();
      if (!(solUsd != null && solUsd > 0)) continue;
      let pair: DexPair | null = null;
      let trades: Awaited<ReturnType<MomentumMarket["trades"]>> = null;
      try {
        pair = await this.deps.market.pair(position.mint);
        if (pair) trades = await this.deps.market.trades(pair.pairAddress, this.deps.now().getTime());
      } catch {
        continue;
      }
      if (!pair || !(pair.priceUsd > 0)) continue;
      const priceSol = pair.priceUsd / solUsd;
      position.lastMarkPriceSol = priceSol;
      position.peakPriceSol = Math.max(position.peakPriceSol ?? priceSol, priceSol);
      const exit = momentumExit({
        entryPriceSol: position.entryPriceSol,
        peakPriceSol: position.peakPriceSol,
        priceSol,
        tp1Taken: position.momentumTp1Taken === true,
        tp2Taken: position.momentumTp2Taken === true,
        sellVolume15mUsd: trades?.sellVolume15mUsd ?? null,
        buyVolume15mUsd: trades?.buyVolume15mUsd ?? null,
        volume15mComplete: trades?.volume15mComplete ?? false,
      });
      if (!exit) continue;
      await this.sell(position, exit.reason, exit.sellFraction, priceSol, pair.marketCapUsd);
    }
  }

  private async sell(
    position: Position,
    reason: TradeReason,
    fraction: number,
    quote: number,
    marketCapUsd: number,
  ): Promise<void> {
    this.selling.add(position.mint);
    try {
      const current = this.deps.positions.get(position.mint);
      if (!current) return;
      const before = current.tokenAmount;
      const portion = Math.min(1, Math.max(0, fraction));
      const requested = portion >= 0.999 ? before : before * portion;
      const turbo = reason === "momentum_sl" || reason === "entry";
      const fees = turbo ? turboFees(this.deps.config) : null;
      const proceeds = quote * requested;
      const fill = await this.deps.executor.sell({
        mint: current.mint,
        name: current.name,
        symbol: current.symbol,
        creator: current.creator,
        sizeSol: current.costSol,
        quotePriceSol: quote,
        slippagePct: momentumSlippagePct(marketCapUsd),
        reason,
        tokenAmount: requested,
        sellFraction: portion,
        pool: current.momentumPool ?? "pump-amm",
        tipSol: fees ? fees.tipSol : tipForTrade(this.deps.config, proceeds, false),
        ...(fees ? { priorityFeeSol: fees.priorityFeeSol } : {}),
        useQuotedSlippage: true,
        hot: turbo,
      });
      const sold = Math.min(before, fill.tokenAmount > 0 ? fill.tokenAmount : requested);
      const share = before > 0 ? sold / before : 1;
      const costAllocated = current.costSol * share;
      const realized = fill.status === "filled" ? fill.cashflowSol - costAllocated : null;
      const total = fill.status === "filled" ? (current.realizedPnlSol ?? 0) + (realized ?? 0) : null;
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
        solUsd: this.deps.solUsd(),
        tokenAmount: fill.status === "filled" ? sold : requested,
        realizedPnlSol: realized,
        realizedPnlTotalSol: total,
        costSol: fill.status === "filled" ? costAllocated : current.costSol,
        triggerPriceSol: quote,
        bundle: "jito",
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
        current.realizedPnlSol = total ?? current.realizedPnlSol;
        if (reason === "momentum_tp1") current.momentumTp1Taken = true;
        if (reason === "momentum_tp2") current.momentumTp2Taken = true;
        return;
      }
      this.deps.positions.close(current.mint);
    } finally {
      this.selling.delete(position.mint);
    }
  }

  private async balance(): Promise<{ balanceSol: number; freeSol: number }> {
    const openCost = this.deps.positions.list().reduce((sum, position) => sum + Math.max(0, position.costSol), 0);
    if (this.deps.config.mode === "paper") {
      const cash = this.deps.paperBalance?.cash() ?? 0;
      return { balanceSol: cash + openCost, freeSol: cash };
    }
    const wallet = this.deps.walletBalanceSol ? await this.deps.walletBalanceSol() : 0;
    const reserve = this.deps.config.liveBalanceReserveSol;
    return { balanceSol: wallet + openCost - reserve, freeSol: Math.max(0, wallet - reserve) };
  }

  private entriesHalted(): boolean {
    const max = this.deps.config.maxDailyLossSol;
    if (max == null) return false;
    const realized = this.daily.realized(this.deps.config.mode, berlinDay(this.deps.now().toISOString()));
    return realized <= -max;
  }

  private logDecision(
    mint: string,
    decision: "buy" | "hold",
    reason: string,
    confidence: number | null,
    extra: Record<string, unknown> = {},
  ): void {
    this.deps.log.info("momentum", { mint, decision, reason, confidence, ...extra });
  }
}
