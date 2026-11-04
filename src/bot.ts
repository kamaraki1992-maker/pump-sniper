import type { BoughtMints } from "./bought.js";
import { bondingCurveAddress } from "./curve-watch.js";
import { confidenceBreakdown, sizeFromConfidence, type ConfidenceBreakdown } from "./confidence.js";
import { clampBuyUsd, requiredBuyBalanceSol, type AppConfig } from "./config.js";
import { SOL_PRICE_MAX_AGE_MS } from "./sol-price.js";
import type { FilterDecision } from "./filter.js";
import { holdDecision } from "./filter.js";
import { Logger } from "./logger.js";
import type { PositionBook } from "./positions.js";
import { assessMark, curveBuyPrice, curveSellPrice, poolSellPrice, poolSpot, reservesOnCurve, TOTAL_SUPPLY_TOKENS } from "./pricing.js";
import type { TradeLog } from "./report.js";
import { decideExit, nextTrailFloor, reservesDropped } from "./risk.js";
import type { SafetyCheckResult } from "./safety.js";
import type { Executor, MarketGraduation, MarketLaunch, MarketTrade, OrderRequest, Position, TradeReason } from "./types.js";

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
  unsubscribeMint: (mint: string) => void;
  /** Mints already reserved, including ones whose position has since closed. */
  bought?: BoughtMints;
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
  /** Live bonding-curve reserves from getAccountInfo. Used only when no trade or curve-watch sample exists. */
  readCurveReserves?: (mint: string) => Promise<{ vSol: number; vTokens: number } | null>;
}

const MAX_OPEN_LOG_MS = 5_000;

function confidenceFields(confidence: ConfidenceBreakdown): Record<string, number> {
  return {
    hold: confidence.hold,
    flow: confidence.flow,
    safety: confidence.safety,
    raw: confidence.raw,
    score: confidence.score,
  };
}

export class SniperBot {
  private readonly seen = new Set<string>();
  private readonly pendingBuys = new Set<string>();
  private readonly selling = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private lastMaxOpenLogMs = Number.NEGATIVE_INFINITY;
  private readonly flow = new Map<string, Array<{ at: number; side: "buy" | "sell" }>>();
  private readonly lastMarketTradeAt = new Map<string, number>();
  private readonly lastMarkLog = new Map<string, { at: number; floor: number | null }>();
  private readonly pendingExit = new Map<string, TradeReason>();
  /** Latest on-curve reserves from a trade or curve-watch update. Launch snapshots are not stored. */
  private readonly freshReserves = new Map<string, { vSol: number; vTokens: number }>();
  private stopped = false;

  constructor(private readonly deps: BotDeps) {
    for (const mint of deps.bought?.list() ?? []) this.seen.add(mint);
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
    if (this.deps.bought?.has(launch.mint)) {
      this.skip(launch, "already_bought");
      return;
    }
    if (this.seen.has(launch.mint) || this.deps.positions.get(launch.mint) || this.pendingBuys.has(launch.mint)) {
      return;
    }
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
    const { sizeUsd, sizeSol, confidence } = orderSize;
    const quotePriceSol = await this.entryQuote(launch, sizeSol);
    if (quotePriceSol == null) {
      this.skip(launch, "no-fresh-reserves");
      return;
    }
    if (!this.tryReserve(launch.mint)) {
      this.skipMaxOpen(launch);
      return;
    }

    let held = false;
    this.deps.bought?.add(launch.mint);
    this.deps.subscribeMint(launch.mint);
    const order: OrderRequest = {
      mint: launch.mint,
      name: launch.name,
      symbol: launch.symbol,
      creator: launch.creator,
      sizeSol,
      quotePriceSol,
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
        confidence: confidence.score,
      });
      if (fill.status !== "filled") {
        this.deps.log.info("buy failed", {
          mint: launch.mint,
          error: fill.error,
          sizeUsd,
          sizeSol,
          ...confidenceFields(confidence),
        });
        return;
      }
      held = true;
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
        lastVTokens: launch.vTokens,
        bondingCurve: bondingCurveAddress(launch.mint, launch.bondingCurveKey),
        lastTradeAtMs: this.lastMarketTradeAt.get(launch.mint) ?? this.deps.now().getTime(),
        tradesSeen: 0,
      };
      this.deps.positions.open(position);
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
        ...confidenceFields(confidence),
      });
    } finally {
      this.pendingBuys.delete(launch.mint);
      if (!held) this.deps.unsubscribeMint(launch.mint);
    }
  }

  async onTrade(trade: MarketTrade): Promise<void> {
    this.rememberReserves(trade.mint, trade.vSolSol, trade.vTokens ?? null);
    const now = this.deps.now().getTime();
    this.lastMarketTradeAt.set(trade.mint, now);
    this.noteTrade(trade.mint, trade.txType, now);
    const position = this.deps.positions.get(trade.mint);
    if (!position) return;
    position.tradesSeen = (position.tradesSeen ?? 0) + 1;
    position.lastTradeAtMs = now;
    if (trade.venue === "pumpswap") {
      this.noteGraduation(position, null);
      this.applyPool(position, trade.poolBaseTokens ?? null, trade.poolQuoteSol ?? null);
      await this.afterMark(position, "pool");
      return;
    }
    if (position.graduated) {
      await this.afterMark(position, "pool");
      return;
    }
    if (trade.vSolSol !== null && trade.vSolSol > 0) position.lastVSolSol = trade.vSolSol;
    this.applyMark(position, trade.priceSol, trade.vSolSol, trade.vTokens ?? null);
    await this.afterMark(position, "trade");
  }

  async onGraduation(event: MarketGraduation): Promise<void> {
    const position = this.deps.positions.get(event.mint);
    if (!position || this.stopped) return;
    this.noteGraduation(position, event.pool);
    this.applyPool(position, event.baseTokens, event.quoteSol);
    await this.afterMark(position, "pool");
  }

  /** Timer entry. Sells a quiet position once max hold elapses, without a new trade. */
  async checkHolds(): Promise<void> {
    if (this.stopped) return;
    for (const position of this.deps.positions.list()) {
      await this.maybeExit(position, position.lastMarkPriceSol);
    }
  }

  /** Bonding-curve account notification. The first sample is the entry baseline. */
  onCurveReserves(
    mint: string,
    realSol: number,
    reserves?: { vSol: number; vTokens: number } | null,
    complete?: boolean,
  ): void {
    if (reserves) this.rememberReserves(mint, reserves.vSol, reserves.vTokens);
    const position = this.deps.positions.get(mint);
    if (!position || this.stopped || !(realSol >= 0)) return;
    if (complete || position.graduated) {
      this.noteGraduation(position, position.pool ?? null);
      void this.afterMark(position, "pool");
      return;
    }
    if (reserves) this.applyMark(position, reserves.vSol / reserves.vTokens, reserves.vSol, reserves.vTokens);
    if (position.entryRealSolSol == null) {
      position.entryRealSolSol = realSol;
      position.lastRealSolSol = realSol;
      void this.afterMark(position, "curve");
      return;
    }
    position.lastRealSolSol = realSol;
    if (reservesDropped(position.entryRealSolSol, realSol, this.deps.config.liqDropPct)) {
      void this.sellPosition(position, "liquidity_drop", position.lastMarkPriceSol);
      return;
    }
    void this.afterMark(position, "curve");
  }

  private async afterMark(position: Position, source: "trade" | "curve" | "pool"): Promise<void> {
    const pending = this.pendingExit.get(position.mint);
    if (pending && this.executableQuote(position) != null) {
      this.pendingExit.delete(position.mint);
      await this.sellPosition(position, pending, position.lastMarkPriceSol);
      return;
    }
    await this.maybeExit(position, position.lastMarkPriceSol, source);
  }

  private async maybeExit(
    position: Position,
    quote: number,
    source: "trade" | "curve" | "pool" = "trade",
  ): Promise<void> {
    if (this.selling.has(position.mint)) return;
    const cooldown = this.cooldownUntil.get(position.mint) ?? 0;
    if (this.deps.now().getTime() < cooldown) return;
    const openedAtMs = Date.parse(position.openedAt);
    const counts = this.windowCounts(position.mint, this.deps.now().getTime());
    const mark = quote > 0 ? quote : 0;
    if (mark > 0 && position.entryPriceSol > 0) {
      const peak = Math.max(position.peakPriceSol ?? mark, mark);
      position.peakPriceSol = peak;
      position.trailFloorPct = nextTrailFloor(
        position.entryPriceSol,
        peak,
        this.deps.config.trailTiers,
        position.trailFloorPct ?? null,
      );
      this.logMark(position, source);
    }
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
      volumeStallGraceMs: this.deps.config.volumeStallGraceSec * 1000,
      trailFloorPct: position.trailFloorPct ?? null,
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
        const execution = this.sellQuote(current, quote);
        if (execution == null) {
          current.unpriced = true;
          this.pendingExit.set(current.mint, reason);
          this.deps.log.info("unpriced", { mint: current.mint, reason });
          return;
        }
        const fill = await this.deps.executor.sell({
          mint: current.mint,
          name: current.name,
          symbol: current.symbol,
          creator: current.creator,
          sizeSol: current.costSol,
          quotePriceSol: execution,
          ...(current.graduated ? { pool: "pump-amm" as const } : {}),
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
          this.lastMarketTradeAt.delete(current.mint);
          this.deps.curveWatch?.unwatch(current.mint);
          this.deps.unsubscribeMint(current.mint);
          this.deps.log.info("sell filled", {
            mint: current.mint,
            reason,
            realizedPnlSol: realized,
            signature: fill.signature,
            ...(reason === "volume_stall" ? { tradesSeen: current.tradesSeen ?? 0 } : {}),
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

  /**
   * Paper fills sell into this mint's bonding curve. A stream mark is only a
   * signal; it is not the execution price.
   */
  private sellQuote(position: Position, mark: number): number | null {
    if (position.graduated) return poolSellPrice(position.poolBaseTokens, position.poolQuoteSol, position.tokenAmount);
    if (this.deps.config.mode !== "paper") return mark > 0 ? mark : position.lastMarkPriceSol;
    const curve = curveSellPrice(position.lastVSolSol, position.lastVTokens, position.tokenAmount);
    if (curve != null && curve > 0) return curve;
    return mark > 0 ? mark : position.lastMarkPriceSol;
  }

  private executableQuote(position: Position): number | null {
    return this.sellQuote(position, position.lastMarkPriceSol);
  }

  private noteGraduation(position: Position, pool: string | null): void {
    if (!position.graduated) this.deps.log.info("graduated", { mint: position.mint, pool });
    position.graduated = true;
    if (pool) position.pool = pool;
  }

  /** Pool reserves replace the bonding curve. Without them the position stays unpriced. */
  private applyPool(position: Position, baseTokens: number | null, quoteSol: number | null): void {
    if (baseTokens != null && baseTokens > 0) position.poolBaseTokens = baseTokens;
    if (quoteSol != null && quoteSol > 0) position.poolQuoteSol = quoteSol;
    const priced = poolSpot(position.poolBaseTokens, position.poolQuoteSol);
    if (priced == null) {
      if (!position.unpriced) this.deps.log.info("unpriced", { mint: position.mint, reason: "no-pool" });
      position.unpriced = true;
      return;
    }
    position.unpriced = false;
    position.lastMarkPriceSol = priced;
  }

  private logMark(position: Position, source: "trade" | "curve" | "pool"): void {
    const entry = position.entryPriceSol;
    const mark = position.lastMarkPriceSol;
    const peak = position.peakPriceSol ?? mark;
    if (!(entry > 0) || !(mark > 0)) return;
    const floor = position.trailFloorPct ?? null;
    const now = this.deps.now().getTime();
    const prev = this.lastMarkLog.get(position.mint);
    const floorChanged = (prev?.floor ?? null) !== floor;
    if (prev && !floorChanged && now - prev.at < 5_000) return;
    this.lastMarkLog.set(position.mint, { at: now, floor });
    this.deps.log.info("mark", {
      mint: position.mint,
      gainPct: ((mark / entry) - 1) * 100,
      peakGainPct: ((peak / entry) - 1) * 100,
      floorPct: floor,
      source,
    });
  }

  private applyMark(
    position: Position,
    proposed: number | null,
    nextVSol: number | null,
    nextVTokens: number | null,
  ): void {
    const decision = assessMark({
      previous: position.lastMarkPriceSol,
      proposed,
      vSol: position.lastVSolSol ?? null,
      vTokens: position.lastVTokens ?? null,
      nextVSol,
      nextVTokens,
    });
    if (!decision.accept) {
      this.deps.log.info("mark_rejected", {
        mint: position.mint,
        proposed,
        previous: position.lastMarkPriceSol,
        vSol: position.lastVSolSol ?? null,
        vTokens: position.lastVTokens ?? null,
      });
      return;
    }
    if (decision.price != null && decision.price > 0) position.lastMarkPriceSol = decision.price;
    if (decision.vSol != null) position.lastVSolSol = decision.vSol;
    if (decision.vTokens != null) position.lastVTokens = decision.vTokens;
  }

  /**
   * Paper buys pay the constant-product impact of `sizeSol` on reserves seen
   * after the launch. The paper executor adds PAPER_SLIPPAGE_PCT. Launch
   * reserves are never the quote. Live orders keep the stream price.
   */
  private async entryQuote(launch: MarketLaunch, sizeSol: number): Promise<number | null> {
    if (this.deps.config.mode !== "paper") return launch.priceSol;
    const reserves = await this.entryReserves(launch.mint);
    if (!reserves) return null;
    return curveBuyPrice(reserves.vSol, reserves.vTokens, sizeSol);
  }

  private async entryReserves(mint: string): Promise<{ vSol: number; vTokens: number } | null> {
    const cached = this.freshReserves.get(mint);
    if (cached && reservesOnCurve(cached.vSol, cached.vTokens)) return cached;
    const read = this.deps.readCurveReserves;
    if (!read) return null;
    try {
      const loaded = await read(mint);
      if (!loaded || !reservesOnCurve(loaded.vSol, loaded.vTokens)) return null;
      this.freshReserves.set(mint, { vSol: loaded.vSol, vTokens: loaded.vTokens });
      return loaded;
    } catch {
      return null;
    }
  }

  /** A trade or curve-watch sample. Off-curve pairs are ignored so a stale virtual-token field cannot set the price. */
  private rememberReserves(mint: string, vSol: number | null, vTokens: number | null): void {
    if (vSol == null || vTokens == null || !reservesOnCurve(vSol, vTokens)) return;
    this.freshReserves.set(mint, { vSol, vTokens });
  }

  /** USD notional clamped to the hard cap, then SOL at the fresh quote. */
  private quoteBuySize(
    launch: MarketLaunch,
  ): { sizeUsd: number; sizeSol: number; confidence: ConfidenceBreakdown } | null {
    const quote = this.deps.solQuote();
    if (!quote || !(quote.usd > 0) || !Number.isFinite(quote.usd)) return null;
    if (this.deps.now().getTime() - quote.updatedAtMs > SOL_PRICE_MAX_AGE_MS) return null;
    const holdPct = (launch.initialBuyTokens / TOTAL_SUPPLY_TOKENS) * 100;
    const counts = this.windowCounts(launch.mint, this.deps.now().getTime());
    const confidence = confidenceBreakdown({
      holdPct,
      buys: counts.buys,
      sells: counts.sells,
      safetyOk: true,
    });
    const sizeUsd = clampBuyUsd(
      sizeFromConfidence(confidence.score, this.deps.config.buySizeMinUsd, this.deps.config.buySizeMaxUsd),
    );
    if (!(sizeUsd > 0)) return null;
    return { sizeUsd, sizeSol: sizeUsd / quote.usd, confidence };
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
