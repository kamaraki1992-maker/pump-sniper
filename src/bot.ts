import { bondingCurveAddress } from "./curve-watch.js";
import { confidenceScore, sizeFromConfidence } from "./confidence.js";
import { clampBuyUsd, requiredBuyBalanceSol, type AppConfig } from "./config.js";
import { SOL_PRICE_MAX_AGE_MS } from "./sol-price.js";
import type { FilterDecision } from "./filter.js";
import { holdDecision } from "./filter.js";
import { Logger } from "./logger.js";
import type { PositionBook } from "./positions.js";
import { TOTAL_SUPPLY_TOKENS } from "./pricing.js";
import type { TradeLog } from "./report.js";
import { decideExit, reservesDropped } from "./risk.js";
import type { SafetyCheckResult } from "./safety.js";
import type { Executor, MarketLaunch, MarketTrade, OrderRequest, Position, TradeReason } from "./types.js";

export interface BotDeps {
  config: AppConfig;
  executor: Executor;
  history: { lookup(creator: string): Promise<FilterDecision> };
  positions: PositionBook;
  trades: TradeLog;
  log: Logger;
  solUsd: () => number | null;
  /** Live SOL/USD quote and the time it was fetched. Null when unknown. */
  solQuote: () => { usd: number; updatedAtMs: number } | null;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  subscribeMint: (mint: string) => void;
  /** Live mode only. Paper mode does not consult a wallet. */
  walletBalanceSol?: () => Promise<number>;
  safetyCheck?: (input: {
    mint: string;
    vSol: number | null;
    vTokens: number | null;
    spendSol: number;
  }) => Promise<SafetyCheckResult>;
  curveWatch?: {
    watch(mint: string, curve: string): void;
    unwatch(mint: string): void;
    isLive(mint: string): boolean;
    stop?(): void;
  };
}

const MAX_OPEN_LOG_MS = 5_000;

export class SniperBot {
  private readonly seen = new Set<string>();
  private readonly pendingBuys = new Set<string>();
  private readonly selling = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private lastMaxOpenLogMs = Number.NEGATIVE_INFINITY;
  private readonly flow = new Map<string, Array<{ at: number; side: "buy" | "sell" }>>();
  private stopped = false;

  constructor(private readonly deps: BotDeps) {
    for (const position of deps.positions.list()) {
      this.seen.add(position.mint);
      deps.subscribeMint(position.mint);
    }
  }

  stop(): void {
    this.stopped = true;
    this.deps.curveWatch?.stop?.();
  }

  async onLaunch(launch: MarketLaunch): Promise<void> {
    if (this.stopped) return;
    if (this.seen.has(launch.mint) || this.deps.positions.get(launch.mint)) return;
    this.seen.add(launch.mint);
    if (this.occupied() >= this.deps.config.maxOpenPositions) {
      this.skipMaxOpen(launch);
      return;
    }
    if (!launch.solQuoted) {
      this.skip(launch, "non-sol quote");
      return;
    }
    if (!launch.creator) {
      this.skip(launch, "missing-creator");
      return;
    }
    if (!(launch.priceSol && launch.priceSol > 0)) {
      this.skip(launch, "no-price");
      return;
    }
    const hold = holdDecision(launch.initialBuyTokens, this.deps.config.creatorMaxHoldPct);
    if (!hold.ok) {
      this.skip(launch, hold.reason ?? "creator-hold");
      return;
    }
    const history = await this.deps.history.lookup(launch.creator);
    if (!history.ok) {
      this.skip(launch, history.reason ?? "creator-history-unavailable");
      return;
    }
    if (this.stopped) return;
    const sized = this.quoteBuySize(launch);
    if (!sized) {
      this.skip(launch, "no_price");
      return;
    }
    if (this.deps.safetyCheck) {
      const safety = await this.deps.safetyCheck({
        mint: launch.mint,
        vSol: launch.vSolSol,
        vTokens: launch.vTokens,
        spendSol: sized.sizeSol,
      });
      this.deps.log.info("safety", {
        mint: launch.mint,
        ok: safety.ok,
        reason: safety.reason,
        latencyMs: safety.latencyMs,
      });
      if (!safety.ok) {
        this.skip(launch, safety.reason ?? "safety");
        return;
      }
    }
    if (this.stopped) return;
    const orderSize = this.quoteBuySize(launch);
    if (!orderSize) {
      this.skip(launch, "no_price");
      return;
    }
    const { sizeUsd, sizeSol } = orderSize;
    if (!this.tryReserve(launch.mint)) {
      this.skipMaxOpen(launch);
      return;
    }

    const order: OrderRequest = {
      mint: launch.mint,
      name: launch.name,
      symbol: launch.symbol,
      creator: launch.creator,
      sizeSol,
      quotePriceSol: launch.priceSol,
      slippagePct: this.deps.config.maxSlippagePct,
      reason: "entry",
    };
    try {
      if (this.deps.config.mode === "live") {
        const balance = await this.readBalance();
        const required = requiredBuyBalanceSol(
          this.deps.config,
          sizeSol,
          this.deps.positions.list().length,
        );
        if (!(balance >= required)) {
          this.skip(launch, "insufficient_balance", { balanceSol: balance, requiredSol: required });
          return;
        }
      }
      const fill = await this.deps.executor.buy(order);
      this.deps.trades.append({
        timestamp: this.deps.now().toISOString(),
        mode: this.deps.config.mode,
        side: "buy",
        status: fill.status,
        mint: launch.mint,
        name: launch.name,
        symbol: launch.symbol,
        sizeSol: fill.status === "filled" ? fill.sizeSol : order.sizeSol,
        sizeUsd,
        price: fill.price,
        feesSol: fill.feesSol,
        jitoTipSol: fill.jitoTipSol,
        signature: fill.signature || (this.deps.config.mode === "paper" ? "paper" : ""),
        solscan: fill.solscan,
        reason: "entry",
        error: fill.error,
        solUsd: sizeUsd / sizeSol,
        tokenAmount: fill.tokenAmount,
        realizedPnlSol: null,
        costSol: fill.status === "filled" ? fill.cashflowSol : null,
      });
      if (fill.status !== "filled") {
        this.deps.log.info("buy failed", { mint: launch.mint, error: fill.error, sizeUsd, sizeSol });
        return;
      }
      const position: Position = {
        mint: launch.mint,
        name: launch.name,
        symbol: launch.symbol,
        creator: launch.creator,
        tokenAmount: fill.tokenAmount,
        entryPriceSol: fill.price,
        costSol: fill.cashflowSol,
        feesSol: fill.feesSol,
        tipSol: fill.jitoTipSol,
        openedAt: this.deps.now().toISOString(),
        mode: this.deps.config.mode,
        entrySignature: fill.signature,
        lastMarkPriceSol: launch.priceSol,
        entryVSolSol: launch.vSolSol,
        lastVSolSol: launch.vSolSol,
        bondingCurve: bondingCurveAddress(launch.mint, launch.bondingCurveKey),
        lastTradeAtMs: this.deps.now().getTime(),
      };
      this.deps.positions.open(position);
      this.deps.subscribeMint(launch.mint);
      if (position.bondingCurve) this.deps.curveWatch?.watch(launch.mint, position.bondingCurve);
      this.deps.log.info("buy filled", {
        mint: launch.mint,
        name: launch.name,
        price: fill.price,
        tokenAmount: fill.tokenAmount,
        signature: fill.signature,
        openPositions: this.deps.positions.list().length,
        sizeUsd,
        sizeSol,
      });
    } finally {
      this.pendingBuys.delete(launch.mint);
    }
  }

  async onTrade(trade: MarketTrade): Promise<void> {
    const position = this.deps.positions.get(trade.mint);
    if (!position) return;
    const now = this.deps.now().getTime();
    this.noteTrade(trade.mint, trade.txType, now);
    position.lastTradeAtMs = now;
    if (trade.vSolSol !== null && trade.vSolSol > 0) position.lastVSolSol = trade.vSolSol;
    if (trade.priceSol !== null && trade.priceSol > 0) position.lastMarkPriceSol = trade.priceSol;
    await this.maybeExit(position, position.lastMarkPriceSol);
  }

  /** Timer entry. Sells a quiet position once max hold elapses, without a new trade. */
  async checkHolds(): Promise<void> {
    if (this.stopped) return;
    for (const position of this.deps.positions.list()) {
      await this.maybeExit(position, position.lastMarkPriceSol);
    }
  }

  /** Bonding-curve account notification. The first sample is the entry baseline. */
  onCurveReserves(mint: string, realSol: number): void {
    const position = this.deps.positions.get(mint);
    if (!position || this.stopped || !(realSol >= 0)) return;
    if (position.entryRealSolSol == null) {
      position.entryRealSolSol = realSol;
      position.lastRealSolSol = realSol;
      return;
    }
    position.lastRealSolSol = realSol;
    if (reservesDropped(position.entryRealSolSol, realSol, this.deps.config.liqDropPct)) {
      void this.sellPosition(position, "liquidity_drop", position.lastMarkPriceSol);
    }
  }

  private async maybeExit(position: Position, quote: number): Promise<void> {
    if (this.selling.has(position.mint)) return;
    const cooldown = this.cooldownUntil.get(position.mint) ?? 0;
    if (this.deps.now().getTime() < cooldown) return;
    const openedAtMs = Date.parse(position.openedAt);
    const counts = this.windowCounts(position.mint, this.deps.now().getTime());
    const signal = decideExit({
      entryPrice: position.entryPriceSol,
      markPrice: quote,
      takeProfitPct: this.deps.config.takeProfitPct,
      stopLossPct: this.deps.config.stopLossPct,
      openedAtMs,
      nowMs: this.deps.now().getTime(),
      maxHoldMs: this.deps.config.maxHoldMinutes * 60_000,
      entryVSolSol: position.entryVSolSol ?? null,
      lastVSolSol: position.lastVSolSol ?? null,
      liqDropPct: this.deps.config.liqDropPct,
      lastTradeAtMs: position.lastTradeAtMs ?? openedAtMs,
      volumeStallMs: this.deps.config.volumeStallSec * 1000,
      sellsInWindow: counts.sells,
      buysInWindow: counts.buys,
      sellPressureRatio: this.deps.config.sellPressureRatio,
      minPressureSells: 4,
      useStreamLiquidity: this.deps.curveWatch?.isLive(position.mint) !== true,
    });
    if (!signal) return;
    await this.sellPosition(position, signal, quote > 0 ? quote : position.lastMarkPriceSol);
  }

  async panicSell(): Promise<void> {
    const open = this.deps.positions.list();
    for (const position of open) {
      await this.sellPosition(position, "manual", position.lastMarkPriceSol);
    }
  }

  private async sellPosition(position: Position, reason: TradeReason, quote: number): Promise<void> {
    if (this.selling.has(position.mint)) return;
    this.selling.add(position.mint);
    const attempts = Math.max(1, this.deps.config.sellMaxAttempts);
    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const current = this.deps.positions.get(position.mint);
        if (!current) return;
        const fill = await this.deps.executor.sell({
          mint: current.mint,
          name: current.name,
          symbol: current.symbol,
          creator: current.creator,
          sizeSol: current.costSol,
          quotePriceSol: quote > 0 ? quote : current.lastMarkPriceSol,
          slippagePct: this.deps.config.maxSlippagePct,
          reason,
          tokenAmount: current.tokenAmount,
        });
        const realized = fill.status === "filled" ? fill.cashflowSol - current.costSol : null;
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
          tokenAmount: current.tokenAmount,
          realizedPnlSol: realized,
          costSol: current.costSol,
        });
        if (fill.status === "filled") {
          this.deps.positions.close(current.mint);
          this.flow.delete(current.mint);
          this.deps.curveWatch?.unwatch(current.mint);
          this.deps.log.info("sell filled", {
            mint: current.mint,
            reason,
            realizedPnlSol: realized,
            signature: fill.signature,
          });
          return;
        }
        this.deps.log.info("sell failed", {
          mint: current.mint,
          reason,
          attempt,
          error: fill.error,
        });
        if (attempt < attempts) await this.deps.sleep(250 * 2 ** (attempt - 1));
      }
      this.cooldownUntil.set(position.mint, this.deps.now().getTime() + 5_000);
    } finally {
      this.selling.delete(position.mint);
    }
  }

  /** USD notional clamped to the hard cap, then SOL at the fresh quote. */
  private quoteBuySize(launch: MarketLaunch): { sizeUsd: number; sizeSol: number } | null {
    const quote = this.deps.solQuote();
    if (!quote || !(quote.usd > 0) || !Number.isFinite(quote.usd)) return null;
    if (this.deps.now().getTime() - quote.updatedAtMs > SOL_PRICE_MAX_AGE_MS) return null;
    const holdPct = (launch.initialBuyTokens / TOTAL_SUPPLY_TOKENS) * 100;
    const earlyBuys = launch.initialBuyTokens > 0 ? 1 : 0;
    const sizeUsd = clampBuyUsd(
      sizeFromConfidence(
        confidenceScore({ holdPct, buys: earlyBuys, sells: 0, safetyOk: true }),
        this.deps.config.buySizeMinUsd,
        this.deps.config.buySizeMaxUsd,
      ),
    );
    if (!(sizeUsd > 0)) return null;
    return { sizeUsd, sizeSol: sizeUsd / quote.usd };
  }

  private noteTrade(mint: string, side: "buy" | "sell", at: number): void {
    const windowMs = this.deps.config.sellPressureWindowSec * 1000;
    const rows = this.flow.get(mint) ?? [];
    rows.push({ at, side });
    this.flow.set(
      mint,
      rows.filter((row) => row.at >= at - windowMs),
    );
  }

  private windowCounts(mint: string, now: number): { buys: number; sells: number } {
    const windowMs = this.deps.config.sellPressureWindowSec * 1000;
    const rows = (this.flow.get(mint) ?? []).filter((row) => row.at >= now - windowMs);
    return {
      buys: rows.filter((row) => row.side === "buy").length,
      sells: rows.filter((row) => row.side === "sell").length,
    };
  }

  private occupied(): number {
    return this.deps.positions.list().length + this.pendingBuys.size;
  }

  private tryReserve(mint: string): boolean {
    if (this.occupied() >= this.deps.config.maxOpenPositions) return false;
    this.pendingBuys.add(mint);
    return true;
  }

  private async readBalance(): Promise<number> {
    try {
      const balance = await this.deps.walletBalanceSol?.();
      return typeof balance === "number" && Number.isFinite(balance) ? balance : 0;
    } catch (error) {
      this.deps.log.info("wallet balance failed", {
        error: error instanceof Error ? error.message : "balance-error",
      });
      return 0;
    }
  }

  private skipMaxOpen(launch: MarketLaunch): void {
    const now = this.deps.now().getTime();
    if (now - this.lastMaxOpenLogMs < MAX_OPEN_LOG_MS) return;
    this.lastMaxOpenLogMs = now;
    this.skip(launch, "max_open_positions", {
      openPositions: this.deps.positions.list().length,
      pendingBuys: this.pendingBuys.size,
    });
  }

  private skip(launch: MarketLaunch, reason: string, extra?: Record<string, unknown>): void {
    this.deps.log.info("skip", {
      mint: launch.mint,
      name: launch.name,
      symbol: launch.symbol,
      creator: launch.creator,
      reason,
      ...extra,
    });
  }
}
