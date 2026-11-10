import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BoughtMints } from "./bought.js";
import { bondingCurveAddress } from "./curve-watch.js";
import { confidenceBreakdown, sizeFromConfidence, type ConfidenceBreakdown } from "./confidence.js";
import { clampBuyUsd, HARD_CAPS, requiredBuyBalanceSol, reservedPriorityFeeSol, type AppConfig } from "./config.js";
import { DailyLossBook } from "./daily-loss.js";
import type { MetadataSocials, SocialDecision } from "./socials.js";
import { evaluateEntry, entryBucketMs, type EntryPrint } from "./entry.js";
import { berlinDay } from "./report.js";
import { isEmergencyExit, tipForTrade } from "./tip.js";
import { SOL_PRICE_MAX_AGE_MS } from "./sol-price.js";
import type { FilterDecision } from "./filter.js";
import { holdDecision } from "./filter.js";
import type { HolderDecision } from "./holders.js";
import { Logger } from "./logger.js";
import { PaperBalance } from "./paper-balance.js";
import type { PositionBook } from "./positions.js";
import { assessMark, curveBuyPrice, curveSellPrice, EARLY_MARK_MS, INITIAL_CURVE_SPOT, isInitialCurvePrice, poolSellPrice, poolSpot, reservesOnCurve, TOTAL_SUPPLY_TOKENS } from "./pricing.js";
import type { TradeLog } from "./report.js";
import { decideExit, FULL_EXIT_FRACTION, profitLockPrice, ratchetStop, reservesDropped, trailStopPrice, type ExitPlan } from "./risk.js";
import type { SafetyCheckResult } from "./safety.js";
import type { Executor, MarketGraduation, MarketLaunch, MarketTrade, OrderRequest, Position, TradeReason } from "./types.js";

export interface BotDeps {
  config: AppConfig;
  executor: Executor;
  history: { lookup(creator: string): Promise<FilterDecision> };
  /** Top-10 holder check. Absent only in tests that do not exercise it. */
  holders?: { lookup(mint: string): Promise<HolderDecision> };
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
  /** Paper cash ledger used when BUY_SIZE_PCT_OF_BALANCE is set. */
  paperBalance?: PaperBalance;
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
  /** Creator token balance in display tokens. A drop while a position is open is a dev sell. */
  readCreatorBalance?: (mint: string, creator: string) => Promise<number | null>;
  /** Metadata social check. Absent checks fail closed when REQUIRE_SOCIALS is on. */
  metadataSocials?: MetadataSocials;
}

interface EntryWatch {
  launch: MarketLaunch;
  startedAtMs: number;
  startPrice: number;
  price: number;
  slot: number | null;
  signature: string;
  bundled: Set<string>;
  prints: EntryPrint[];
  creatorSold: boolean;
  prevVSol: number | null;
  rugs: Promise<{ ok: boolean; reason: string }>;
  socials: Promise<SocialDecision>;
  earlyTried: boolean;
  /** The early instant passed while socials were still unknown. */
  earlyDeferred: boolean;
}

const MAX_OPEN_LOG_MS = 5_000;
const MIN_PCT_BUY_SOL = 0.005;
const WALLET_BALANCE_CACHE_MS = 10_000;
/** Leave this much of the watch so the entry decision is not held past it. */
const METADATA_DECISION_MARGIN_MS = 300;

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
  private readonly pendingExit = new Map<string, { reason: TradeReason; fraction: number }>();
  /** Latest on-curve reserves from a trade or curve-watch update. Launch snapshots are not stored. */
  private readonly freshReserves = new Map<string, { vSol: number; vTokens: number }>();
  private readonly watched = new Map<string, EntryWatch>();
  private readonly daily: DailyLossBook;
  private dailyStopWritten = false;
  private stopped = false;
  private walletCache: { at: number; sol: number } | null = null;
  /** Mints whose accepted price has already left the untouched initial curve. */
  private readonly tradedAboveInitial = new Set<string>();

  constructor(private readonly deps: BotDeps) {
    this.daily = new DailyLossBook(`${deps.config.dataDir}/daily-pnl.json`);
    for (const mint of deps.bought?.list() ?? []) this.seen.add(mint);
    for (const position of deps.positions.list()) {
      this.seen.add(position.mint);
      deps.subscribeMint(position.mint);
    }
    this.maybePauseFlat();
  }

  stop(): void {
    this.stopped = true;
    this.deps.curveWatch?.stop?.();
  }

  async onLaunch(launch: MarketLaunch): Promise<void> {
    if (this.entriesHalted()) {
      this.skip(launch, "daily_stop");
      return;
    }
    if (this.deps.config.entryWatchMaxSec > 0) {
      await this.watchLaunch(launch);
      return;
    }
    await this.buyAtLaunch(launch);
  }

  private async buyAtLaunch(
    launch: MarketLaunch,
    fromWatch = false,
    entryStage?: "early" | "full",
    noSocials = false,
  ): Promise<void> {
    if (this.stopped) return;
    if (this.entriesHalted()) {
      this.skip(launch, "daily_stop");
      return;
    }
    if (!fromWatch) {
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
      const socialP = this.socialCheck(launch, this.deps.now().getTime());
      if (this.deps.holders) {
        const top10 = await this.withinBudget(
          this.deps.holders.lookup(launch.mint),
          this.deps.config.rugCheckTimeoutMs,
          { ok: false, reason: "top10-timeout", pct: null },
        );
        if (!top10.ok) {
          this.skip(launch, top10.reason ?? "top10", top10.pct != null ? { top10Pct: top10.pct } : undefined);
          return;
        }
      }
      const history = await this.withinBudget(
        this.deps.history.lookup(launch.creator),
        this.deps.config.rugCheckTimeoutMs,
        { ok: false, reason: "creator-history-timeout" },
      );
      if (!history.ok) {
        this.skip(launch, history.reason ?? "creator-history-unavailable");
        return;
      }
      const social = await socialP;
      if (!social.ok) {
        this.skip(launch, social.reason ?? "metadata_unavailable");
        return;
      }
    }
    if (this.stopped) return;
    if (fromWatch && (this.deps.positions.get(launch.mint) || this.pendingBuys.has(launch.mint))) return;
    if (fromWatch && this.occupied() >= this.deps.config.maxOpenPositions) {
      this.skipMaxOpen(launch);
      return;
    }
    const sized = await this.quoteBuySize(launch);
    if (!sized.ok) {
      this.skip(launch, sized.reason, sized.extra);
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
    const orderSize = await this.quoteBuySize(launch);
    if (!orderSize.ok) {
      this.skip(launch, orderSize.reason, orderSize.extra);
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
      slippagePct: this.deps.config.buySlippagePct,
      reason: "entry",
      tipSol: tipForTrade(this.deps.config, sizeSol, false),
    };
    try {
      if (this.deps.config.mode === "live" && this.deps.config.buySizePctOfBalance == null) {
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
        ...(noSocials ? { noSocials: true } : {}),
      });
      if (fill.status === "filled") this.notePaperCash(-fill.cashflowSol);
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
      if (fill.price > INITIAL_CURVE_SPOT * (1 + 1e-6)) this.tradedAboveInitial.add(launch.mint);
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
        lastMarkPriceSol:
          launch.priceSol != null && launch.priceSol > 0 && !isInitialCurvePrice(launch.priceSol)
            ? launch.priceSol
            : fill.price > 0
              ? fill.price
              : (launch.priceSol ?? fill.price),
        entryVSolSol: launch.vSolSol,
        lastVSolSol: launch.vSolSol,
        lastVTokens: launch.vTokens,
        bondingCurve: bondingCurveAddress(launch.mint, launch.bondingCurveKey),
        lastTradeAtMs: this.lastMarketTradeAt.get(launch.mint) ?? this.deps.now().getTime(),
        tradesSeen: 0,
        creatorTokens: launch.initialBuyTokens,
        ...(noSocials ? { noSocials: true } : {}),
      };
      this.deps.positions.open(position);
      if (position.bondingCurve) this.deps.curveWatch?.watch(launch.mint, position.bondingCurve);
      void this.deps.executor.arm?.({
        mint: position.mint,
        name: position.name,
        symbol: position.symbol,
        creator: position.creator,
        sizeSol: position.costSol,
        quotePriceSol: position.lastMarkPriceSol,
        slippagePct: this.deps.config.sellSlippagePct,
        reason: "sl",
        tokenAmount: position.tokenAmount,
        sellFraction: 1,
        tipSol: tipForTrade(this.deps.config, position.costSol, true),
      });
      this.deps.log.info("buy filled", {
        mint: launch.mint,
        name: launch.name,
        price: fill.price,
        tokenAmount: fill.tokenAmount,
        signature: fill.signature,
        openPositions: this.deps.positions.list().length,
        sizeUsd,
        sizeSol,
        ...(orderSize.balanceSol != null ? { balanceSol: orderSize.balanceSol, pct: orderSize.pct } : {}),
        ...(entryStage ? { entryStage } : {}),
        ...(this.deps.config.allowNoSocialsEntry ? { noSocials } : {}),
        jitoTipSol: fill.jitoTipSol,
        ...confidenceFields(confidence),
      });
    } finally {
      this.pendingBuys.delete(launch.mint);
      if (!held) this.deps.unsubscribeMint(launch.mint);
    }
  }

  async onTrade(trade: MarketTrade): Promise<void> {
    const position = this.deps.positions.get(trade.mint);
    if (position && this.ignoredStaleMark(position, trade.priceSol, "trade")) return;
    if (
      !position &&
      trade.priceSol != null &&
      isInitialCurvePrice(trade.priceSol) &&
      this.tradedAboveInitial.has(trade.mint)
    ) {
      this.deps.log.info("stale_mark_ignored", {
        mint: trade.mint,
        price: trade.priceSol,
        source: "trade",
        reason: "initial_curve",
      });
      return;
    }
    if (trade.priceSol != null && trade.priceSol > INITIAL_CURVE_SPOT * (1 + 1e-6)) {
      this.tradedAboveInitial.add(trade.mint);
    }
    this.rememberReserves(trade.mint, trade.vSolSol, trade.vTokens ?? null);
    const now = this.deps.now().getTime();
    this.lastMarketTradeAt.set(trade.mint, now);
    this.noteTrade(trade.mint, trade.txType, now);
    const watch = this.watched.get(trade.mint);
    if (watch) this.noteEntryPrint(watch, trade);
    if (!position) return;
    if (
      this.deps.config.devSellExit &&
      trade.txType === "sell" &&
      trade.trader !== "" &&
      trade.trader === position.creator
    ) {
      const px = trade.priceSol != null && trade.priceSol > 0 ? trade.priceSol : position.lastMarkPriceSol;
      this.applyMark(position, trade.priceSol, trade.vSolSol, trade.vTokens ?? null);
      position.creatorTokens = 0;
      await this.sellPosition(position, "dev_sell", px);
      return;
    }
    const prevMark = position.lastMarkPriceSol;
    const printPx = trade.priceSol;
    if (
      trade.venue !== "pumpswap" &&
      !position.graduated &&
      prevMark > 0 &&
      printPx != null &&
      printPx > 0 &&
      ((prevMark - printPx) / prevMark) * 100 >= this.deps.config.stopFastDropPct
    ) {
      this.applyMark(position, printPx, trade.vSolSol, trade.vTokens ?? null);
      await this.sellPosition(position, "fast_drop", printPx);
      return;
    }
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
    this.applyMark(position, trade.priceSol, trade.vSolSol, trade.vTokens ?? null);
    if ((trade.vTokens == null || !(trade.vTokens > 0)) && trade.vSolSol !== null && trade.vSolSol > 0) {
      position.lastVSolSol = trade.vSolSol;
    }
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
      if (await this.creatorBalanceDropped(position)) continue;
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
    const position = this.deps.positions.get(mint);
    if (position && reserves && this.ignoredStaleMark(position, reserves.vSol / reserves.vTokens, "curve")) return;
    if (reserves) this.rememberReserves(mint, reserves.vSol, reserves.vTokens);
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
      await this.sellPosition(position, pending.reason, position.lastMarkPriceSol, pending.fraction);
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
    const openedAtMs = Date.parse(position.openedAt);
    const counts = this.windowCounts(position.mint, this.deps.now().getTime());
    const mark = quote > 0 ? quote : 0;
    if (mark > 0 && position.entryPriceSol > 0) {
      const peak = Math.max(position.peakPriceSol ?? mark, mark);
      position.peakPriceSol = peak;
      const nextStop = trailStopPrice(
        position.entryPriceSol,
        peak,
        this.deps.config.trailActivatePct,
        this.deps.config.trailDistancePct,
      );
      position.trailStopPriceSol = ratchetStop(position.trailStopPriceSol, nextStop);
      const nextLock = profitLockPrice(
        position.entryPriceSol,
        peak,
        this.deps.config.profitLockTriggerPct,
        this.deps.config.profitLockFloorPct,
      );
      position.profitLockPriceSol = ratchetStop(position.profitLockPriceSol, nextLock);
      position.trailFloorPct =
        position.trailStopPriceSol != null
          ? ((position.trailStopPriceSol / position.entryPriceSol) - 1) * 100
          : null;
      this.logMark(position, source);
    }
    const plan = decideExit({
      entryPrice: position.entryPriceSol,
      markPrice: quote,
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
      trailStopPriceSol: position.trailStopPriceSol ?? null,
      profitLockPriceSol: position.profitLockPriceSol ?? null,
      tp1Pct: this.deps.config.tp1Pct,
      tp1SellFraction: this.deps.config.tp1SellFraction,
      tp1Taken: position.tp1Taken === true,
      sellsInWindow: counts.sells,
      buysInWindow: counts.buys,
      sellPressureRatio: this.deps.config.sellPressureRatio,
      minPressureSells: 4,
      useStreamLiquidity: this.deps.curveWatch?.isLive(position.mint) !== true,
    });
    const timed =
      !plan && position.noSocials === true && position.entryPriceSol > 0
        ? this.noSocialsTimeStop(position, openedAtMs)
        : null;
    const early =
      !plan &&
      !timed &&
      position.noSocials !== true &&
      this.deps.config.earlyExitWindowSec > 0 &&
      position.entryPriceSol > 0
        ? this.earlyMomentum(position, openedAtMs)
        : null;
    const exit = plan ?? timed ?? early;
    if (!exit) return;
    const hot = isEmergencyExit(exit.signal) || exit.signal === "early_no_momentum" || exit.signal === "profit_lock" || exit.signal === "no_socials_time_stop";
    const cooldown = this.cooldownUntil.get(position.mint) ?? 0;
    if (!hot && this.deps.now().getTime() < cooldown) return;
    await this.sellPosition(position, exit.signal, quote > 0 ? quote : position.lastMarkPriceSol, exit.fraction);
  }

  private earlyMomentum(position: Position, openedAtMs: number): ExitPlan | null {
    const windowMs = this.deps.config.earlyExitWindowSec * 1000;
    if (!(windowMs > 0) || this.deps.now().getTime() - openedAtMs < windowMs) return null;
    const peak = position.peakPriceSol ?? position.lastMarkPriceSol;
    if (!(peak > 0) || !(position.entryPriceSol > 0)) return null;
    const gain = ((peak / position.entryPriceSol) - 1) * 100;
    if (gain + 1e-9 >= this.deps.config.earlyExitMinGainPct) return null;
    return { signal: "early_no_momentum", fraction: FULL_EXIT_FRACTION };
  }

  /** No-socials positions that never reached the gain target are closed in full. */
  private noSocialsTimeStop(position: Position, openedAtMs: number): ExitPlan | null {
    const windowSec = this.deps.config.noSocialsTimeStopSec;
    const minGain = this.deps.config.noSocialsMinGainPct;
    if (windowSec == null || minGain == null || !(windowSec > 0) || !(minGain > 0)) return null;
    if (this.deps.now().getTime() - openedAtMs < windowSec * 1000) return null;
    const peak = position.peakPriceSol ?? position.lastMarkPriceSol;
    if (!(peak > 0) || !(position.entryPriceSol > 0)) return null;
    const gain = ((peak / position.entryPriceSol) - 1) * 100;
    if (gain + 1e-9 >= minGain) return null;
    return { signal: "no_socials_time_stop", fraction: FULL_EXIT_FRACTION };
  }

  async panicSell(): Promise<void> {
    const open = this.deps.positions.list();
    for (const position of open) {
      await this.sellPosition(position, "manual", position.lastMarkPriceSol);
    }
  }

  private async sellPosition(position: Position, reason: TradeReason, quote: number, fraction = 1): Promise<void> {
    if (this.selling.has(position.mint)) return;
    this.selling.add(position.mint);
    const attempts = Math.max(1, this.deps.config.sellMaxAttempts);
    const portion = Math.min(1, Math.max(0, fraction));
    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const current = this.deps.positions.get(position.mint);
        if (!current) return;
        const before = current.tokenAmount;
        const requested = portion >= 0.999 ? before : before * portion;
        const stopLike = isEmergencyExit(reason) || reason === "early_no_momentum" || reason === "profit_lock" || reason === "no_socials_time_stop";
        const execution = stopLike
          ? quote > 0
            ? quote
            : current.lastMarkPriceSol
          : this.sellQuote(current, quote, requested);
        if (execution == null) {
          current.unpriced = true;
          this.pendingExit.set(current.mint, { reason, fraction: portion });
          this.deps.log.info("unpriced", { mint: current.mint, reason });
          return;
        }
        const proceeds = execution * requested;
        const fill = await this.deps.executor.sell({
          mint: current.mint,
          name: current.name,
          symbol: current.symbol,
          creator: current.creator,
          sizeSol: current.costSol,
          quotePriceSol: execution,
          ...(current.graduated ? { pool: "pump-amm" as const } : {}),
          slippagePct: this.deps.config.sellSlippagePct,
          reason,
          tokenAmount: requested,
          sellFraction: portion,
          tipSol: tipForTrade(this.deps.config, proceeds, isEmergencyExit(reason)),
          useQuotedSlippage: stopLike,
          hot: attempt === 1 && isEmergencyExit(reason),
        });
        const reported = fill.tokenAmount > 0 ? fill.tokenAmount : requested;
        const sold = Math.min(before, reported);
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
          ...(current.noSocials ? { noSocials: true } : {}),
        });
        if (fill.status === "filled") {
          this.notePaperCash(fill.cashflowSol);
          if (realized !== null) this.noteRealized(realized);
          const remaining = before - sold;
          const partial = remaining > 1e-9 && share < 0.999;
          this.deps.log.info("sell filled", {
            mint: current.mint,
            reason,
            realizedPnlSol: realized,
            realizedPnlTotalSol: total,
            signature: fill.signature,
            triggerMarkSol: quote,
            fillPriceSol: fill.price,
            jitoTipSol: fill.jitoTipSol,
            bundle: "jito",
            fraction: share,
            remainingTokenAmount: partial ? remaining : 0,
            ...(reason === "volume_stall" ? { tradesSeen: current.tradesSeen ?? 0 } : {}),
          });
          if (partial) {
            current.tokenAmount = remaining;
            current.costSol -= costAllocated;
            current.realizedPnlSol = total ?? current.realizedPnlSol;
            if (reason === "tp") current.tp1Taken = true;
            return;
          }
          this.deps.positions.close(current.mint);
          this.flow.delete(current.mint);
          this.lastMarketTradeAt.delete(current.mint);
          this.deps.curveWatch?.unwatch(current.mint);
          this.deps.unsubscribeMint(current.mint);
          this.maybePauseFlat();
          return;
        }
        this.deps.log.info("sell failed", {
          mint: current.mint,
          reason,
          attempt,
          error: fill.error,
        });
        if (attempt < attempts && !stopLike) await this.deps.sleep(250 * 2 ** (attempt - 1));
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
  private sellQuote(position: Position, mark: number, tokenAmount = position.tokenAmount): number | null {
    if (position.graduated) return poolSellPrice(position.poolBaseTokens, position.poolQuoteSol, tokenAmount);
    if (this.deps.config.mode !== "paper") return mark > 0 ? mark : position.lastMarkPriceSol;
    const vSol = position.lastVSolSol;
    const vTokens = position.lastVTokens;
    const curve = curveSellPrice(vSol, vTokens, tokenAmount);
    const spot = vSol != null && vTokens != null && vTokens > 0 ? vSol / vTokens : null;
    const sameReserves = spot != null && mark > 0 && spot / mark >= 0.95 && spot / mark <= 1.05;
    if (curve != null && curve > 0 && sameReserves) return curve;
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

  /**
   * A post-buy print more than the configured drop below entry is ignored.
   * A print at the untouched initial curve is ignored once this mint has traded above it.
   * Neither case runs exit rules.
   */
  private ignoredStaleMark(position: Position, price: number | null, source: "trade" | "curve"): boolean {
    if (price == null || !(price > 0)) return false;
    const above = position.entryPriceSol > INITIAL_CURVE_SPOT * (1 + 1e-6)
      || position.lastMarkPriceSol > INITIAL_CURVE_SPOT * (1 + 1e-6)
      || this.tradedAboveInitial.has(position.mint);
    if (isInitialCurvePrice(price) && above) {
      this.deps.log.info("stale_mark_ignored", {
        mint: position.mint,
        price,
        source,
        reason: "initial_curve",
      });
      return true;
    }
    const guardMs = this.deps.config.postBuyGuardMs;
    const dropLimit = this.deps.config.postBuyGuardDropPct;
    if (guardMs == null || dropLimit == null || !(position.entryPriceSol > 0)) return false;
    const ageMs = this.deps.now().getTime() - Date.parse(position.openedAt);
    if (!(ageMs >= 0) || ageMs > guardMs) return false;
    const dropPct = ((position.entryPriceSol - price) / position.entryPriceSol) * 100;
    if (dropPct > dropLimit) {
      this.deps.log.info("stale_mark_ignored", {
        mint: position.mint,
        price,
        source,
        reason: "post_buy",
        ageMs,
        dropPct,
      });
      return true;
    }
    return false;
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
    const openedAtMs = Date.parse(position.openedAt);
    const ageMs = this.deps.now().getTime() - openedAtMs;
    const decision = assessMark({
      previous: position.lastMarkPriceSol,
      proposed,
      vSol: position.lastVSolSol ?? null,
      vTokens: position.lastVTokens ?? null,
      nextVSol,
      nextVTokens,
      early: Number.isFinite(openedAtMs) && ageMs >= 0 && ageMs <= EARLY_MARK_MS,
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

  private async watchLaunch(launch: MarketLaunch): Promise<void> {
    if (this.stopped) return;
    if (this.deps.bought?.has(launch.mint)) {
      this.skip(launch, "already_bought");
      return;
    }
    if (this.seen.has(launch.mint) || this.deps.positions.get(launch.mint) || this.pendingBuys.has(launch.mint)) {
      return;
    }
    if (!launch.solQuoted) {
      this.seen.add(launch.mint);
      this.skip(launch, "non-sol quote");
      return;
    }
    if (!launch.creator) {
      this.seen.add(launch.mint);
      this.skip(launch, "missing-creator");
      return;
    }
    if (!(launch.priceSol && launch.priceSol > 0)) {
      this.seen.add(launch.mint);
      this.skip(launch, "no-price");
      return;
    }
    const hold = holdDecision(launch.initialBuyTokens, this.deps.config.creatorMaxHoldPct);
    if (!hold.ok) {
      this.seen.add(launch.mint);
      this.skip(launch, hold.reason ?? "creator-hold");
      return;
    }
    if (this.watched.size >= this.deps.config.entryMaxWatched) {
      this.seen.add(launch.mint);
      this.skip(launch, "entry_watch_full");
      return;
    }
    this.seen.add(launch.mint);
    this.deps.subscribeMint(launch.mint);
    const startedAtMs = this.deps.now().getTime();
    const watch: EntryWatch = {
      launch,
      startedAtMs,
      startPrice: launch.priceSol,
      price: launch.priceSol,
      slot: launch.slot ?? null,
      signature: launch.signature,
      bundled: new Set<string>(),
      prints: [],
      creatorSold: false,
      prevVSol: launch.vSolSol,
      rugs: this.rugChecks(launch),
      socials: this.socialCheck(launch, startedAtMs),
      earlyTried: false,
      earlyDeferred: false,
    };
    this.watched.set(launch.mint, watch);
    const minMs = this.deps.config.entryWatchMinSec * 1000;
    const maxMs = this.deps.config.entryWatchMaxSec * 1000;
    try {
      while (!this.stopped && this.watched.has(launch.mint)) {
        if (this.entriesHalted()) {
          this.skip(launch, "daily_stop");
          return;
        }
        const now = this.deps.now().getTime();
        if (watch.creatorSold) {
          this.skip(launch, "entry_creator_sold");
          return;
        }
        const elapsed = now - startedAtMs;
        const earlyMs = this.deps.config.entryEarlySec != null ? this.deps.config.entryEarlySec * 1000 : null;
        if (earlyMs != null && !watch.earlyTried && elapsed >= earlyMs && elapsed < maxMs) {
          const rug = await this.rugReady(watch.rugs);
          const social = await this.rugReady(watch.socials);
          const lane = this.socialLane(social, startedAtMs, now);
          if (lane === "pending") {
            watch.earlyDeferred = true;
          } else if (lane === "no_socials" && rug == null) {
            // Rug checks are still running. Try the early pass again on the next tick.
          } else {
            watch.earlyTried = true;
            const earlyOk = lane === "no_socials" || (lane === "ok" && !watch.earlyDeferred);
            if (earlyOk && rug?.ok) {
              const verdict = evaluateEntry(
                this.entrySample(watch, now, this.deps.config.entryEarlyMinNetBuySol ?? undefined),
              );
              if (verdict.ok) {
                this.watched.delete(launch.mint);
                await this.buyAtLaunch(launch, true, "early", lane === "no_socials");
                return;
              }
            }
          }
        }
        if (elapsed >= minMs) {
          const rug = await this.rugReady(watch.rugs);
          if (rug && !rug.ok) {
            this.skip(launch, rug.reason);
            return;
          }
          const social = await this.rugReady(watch.socials);
          const lane = this.socialLane(social, startedAtMs, now);
          if (lane === "reject") {
            this.skip(launch, social?.reason ?? "metadata_unavailable");
            return;
          }
          const verdict = evaluateEntry(this.entrySample(watch, now));
          if (verdict.ok && rug?.ok && (lane === "ok" || lane === "no_socials")) {
            this.watched.delete(launch.mint);
            await this.buyAtLaunch(
              launch,
              true,
              this.deps.config.entryEarlySec != null ? "full" : undefined,
              lane === "no_socials",
            );
            return;
          }
        }
        if (elapsed >= maxMs) {
          const rug = await watch.rugs;
          if (!rug.ok) {
            this.skip(launch, rug.reason);
            return;
          }
          const social = await watch.socials;
          const lane = this.socialLane(social, startedAtMs, this.deps.now().getTime());
          if (lane === "no_socials") {
            const verdict = evaluateEntry(this.entrySample(watch, this.deps.now().getTime()));
            if (verdict.ok) {
              this.watched.delete(launch.mint);
              await this.buyAtLaunch(launch, true, this.deps.config.entryEarlySec != null ? "full" : undefined, true);
              return;
            }
            this.skip(launch, verdict.reason);
            return;
          }
          if (lane !== "ok") {
            this.skip(launch, social.reason ?? "metadata_unavailable");
            return;
          }
          const verdict = evaluateEntry(this.entrySample(watch, this.deps.now().getTime()));
          this.skip(launch, verdict.ok ? "entry_timeout" : verdict.reason);
          return;
        }
        const before = now;
        await this.deps.sleep(200);
        if (this.deps.now().getTime() === before) {
          this.skip(launch, "entry_timeout");
          return;
        }
      }
    } finally {
      this.watched.delete(launch.mint);
      if (!this.deps.positions.get(launch.mint) && !this.pendingBuys.has(launch.mint)) {
        this.deps.unsubscribeMint(launch.mint);
      }
    }
  }

  private rugChecks(launch: MarketLaunch): Promise<{ ok: boolean; reason: string }> {
    const top10P = this.deps.holders
      ? this.withinBudget(this.deps.holders.lookup(launch.mint), this.deps.config.rugCheckTimeoutMs, {
          ok: false,
          reason: "top10-timeout",
          pct: null,
        })
      : Promise.resolve({ ok: true, reason: "", pct: null });
    const historyP = this.withinBudget(
      this.deps.history.lookup(launch.creator),
      this.deps.config.rugCheckTimeoutMs,
      { ok: false, reason: "creator-history-timeout" },
    );
    return Promise.all([top10P, historyP]).then(([top10, history]) => {
      if (!top10.ok) return { ok: false, reason: top10.reason ?? "top10" };
      if (!history.ok) return { ok: false, reason: history.reason ?? "creator-history-unavailable" };
      return { ok: true, reason: "" };
    });
  }

  private allowNoSocialsEntry(): boolean {
    return this.deps.config.allowNoSocialsEntry && this.deps.config.requireSocials;
  }

  /**
   * `ok` keeps the normal socials path. `no_socials` is the fast lane.
   * `pending` means the metadata result is not final yet. `reject` skips.
   */
  private socialLane(
    social: SocialDecision | null,
    startedAtMs: number,
    nowMs: number,
  ): "pending" | "ok" | "no_socials" | "reject" {
    if (!this.deps.config.requireSocials) return "ok";
    const deadlinePassed = nowMs >= this.socialDeadline(startedAtMs);
    if (!social) return this.allowNoSocialsEntry() && deadlinePassed ? "no_socials" : "pending";
    if (social.ok) return "ok";
    if (!this.allowNoSocialsEntry()) return "reject";
    if (social.reason === "no_socials") return "no_socials";
    if (social.reason === "metadata_unavailable" && deadlinePassed) return "no_socials";
    if (social.reason === "metadata_unavailable") return "pending";
    return "reject";
  }

  /** Retry budget for this watch. Ends a margin before the entry decision. */
  private socialDeadline(startedAtMs: number): number {
    const config = this.deps.config;
    const windowMs = config.entryWatchMaxSec * 1000;
    const budgetMs = (config.metadataRetryDeadlineSec ?? config.entryWatchMaxSec) * 1000;
    if (windowMs <= 0) return startedAtMs + budgetMs;
    return Math.min(startedAtMs + budgetMs, startedAtMs + windowMs - METADATA_DECISION_MARGIN_MS);
  }

  private socialCheck(launch: MarketLaunch, startedAtMs: number): Promise<SocialDecision> {
    if (!this.deps.config.requireSocials) {
      return Promise.resolve({ ok: true, reason: null, twitter: null, telegram: null });
    }
    const uri = launch.metadataUri?.trim() ?? "";
    const finish = (decision: SocialDecision): SocialDecision => {
      this.deps.log.info("socials", {
        mint: launch.mint,
        ok: decision.ok,
        reason: decision.reason,
        twitter: decision.twitter,
        telegram: decision.telegram,
        latency_ms: decision.latencyMs ?? 0,
        attempts: decision.attempts ?? 0,
        gateway: decision.gateway ?? null,
      });
      return decision;
    };
    if (!uri || !this.deps.metadataSocials) {
      return Promise.resolve(
        finish({ ok: false, reason: "metadata_unavailable", twitter: null, telegram: null, attempts: 0, latencyMs: 0, gateway: null }),
      );
    }
    return this.deps.metadataSocials.lookup(uri, { deadlineAtMs: this.socialDeadline(startedAtMs) }).then(finish);
  }

  /** Resolved check, or null when it is still running. */
  private async rugReady<T>(work: Promise<T>): Promise<T | null> {
    return Promise.race([
      work,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 0);
      }),
    ]);
  }

  private entrySample(watch: EntryWatch, nowMs: number, minNetBuySol?: number) {
    const config = this.deps.config;
    return {
      startedAtMs: watch.startedAtMs,
      nowMs,
      startPrice: watch.startPrice,
      price: watch.price,
      creator: watch.launch.creator,
      bundled: watch.bundled,
      prints: watch.prints,
      minBuys: config.entryMinBuys,
      minUniqueBuyers: config.entryMinUniqueBuyers,
      minNetBuySol: minNetBuySol ?? config.entryMinNetBuySol,
      minBuyRatio: config.entryMinBuyRatio,
      maxRunupPct: config.entryMaxRunupPct,
      bucketMs: entryBucketMs(
        watch.startedAtMs,
        nowMs,
        config.entryBucketSec != null ? config.entryBucketSec * 1000 : undefined,
      ),
    };
  }

  private noteEntryPrint(watch: EntryWatch, trade: MarketTrade): void {
    const sameSlot = watch.slot != null && trade.slot != null && trade.slot === watch.slot;
    const sameCreate = trade.signature !== "" && trade.signature === watch.signature;
    if (sameSlot || sameCreate) {
      if (trade.trader) watch.bundled.add(trade.trader);
      return;
    }
    let sol = trade.solAmount != null && trade.solAmount > 0 ? trade.solAmount : 0;
    if (!(sol > 0) && trade.vSolSol != null && watch.prevVSol != null) {
      sol = Math.abs(trade.vSolSol - watch.prevVSol);
    }
    if (trade.vSolSol != null && trade.vSolSol > 0) watch.prevVSol = trade.vSolSol;
    if (trade.txType === "sell" && trade.trader === watch.launch.creator) watch.creatorSold = true;
    if (trade.priceSol != null && trade.priceSol > 0) watch.price = trade.priceSol;
    watch.prints.push({
      atMs: this.deps.now().getTime(),
      side: trade.txType,
      trader: trade.trader,
      sol,
    });
  }

  private async creatorBalanceDropped(position: Position): Promise<boolean> {
    if (!this.deps.config.devSellExit || !this.deps.readCreatorBalance) return false;
    if (position.creatorTokens == null) return false;
    try {
      const balance = await this.deps.readCreatorBalance(position.mint, position.creator);
      if (balance == null) return false;
      if (balance + 1e-6 < position.creatorTokens) {
        position.creatorTokens = balance;
        await this.sellPosition(position, "dev_sell", position.lastMarkPriceSol);
        return true;
      }
      position.creatorTokens = balance;
    } catch {
      return false;
    }
    return false;
  }

  /** USD notional clamped to the hard cap, then SOL at the fresh quote. Percent of balance wins, then BUY_SIZE_SOL. */
  private async quoteBuySize(launch: MarketLaunch): Promise<
    | {
        ok: true;
        sizeUsd: number;
        sizeSol: number;
        confidence: ConfidenceBreakdown;
        balanceSol?: number;
        pct?: number;
      }
    | { ok: false; reason: string; extra?: Record<string, unknown> }
  > {
    const quote = this.deps.solQuote();
    if (!quote || !(quote.usd > 0) || !Number.isFinite(quote.usd)) return { ok: false, reason: "no_price" };
    if (this.deps.now().getTime() - quote.updatedAtMs > SOL_PRICE_MAX_AGE_MS) return { ok: false, reason: "no_price" };
    const holdPct = (launch.initialBuyTokens / TOTAL_SUPPLY_TOKENS) * 100;
    const counts = this.windowCounts(launch.mint, this.deps.now().getTime());
    const confidence = confidenceBreakdown({
      holdPct,
      buys: counts.buys,
      sells: counts.sells,
      safetyOk: true,
    });
    const pct = this.deps.config.buySizePctOfBalance;
    if (pct != null) {
      const parts = await this.balanceParts();
      const rawSol = (parts.balanceSol * pct) / 100;
      const sizeUsd = clampBuyUsd(rawSol * quote.usd);
      const sizeSol = quote.usd > 0 ? sizeUsd / quote.usd : 0;
      const extra = { sizeSol, balanceSol: parts.balanceSol, pct, freeSol: parts.freeSol };
      if (!(sizeSol >= MIN_PCT_BUY_SOL)) return { ok: false, reason: "buy_size_min", extra };
      const overhead = reservedPriorityFeeSol(this.deps.config) + this.deps.config.paper.baseFeeSol + tipForTrade(this.deps.config, sizeSol, false);
      if (!(parts.freeSol >= sizeSol + overhead)) {
        return { ok: false, reason: "insufficient_balance", extra: { ...extra, requiredSol: sizeSol + overhead } };
      }
      return { ok: true, sizeUsd, sizeSol, confidence, balanceSol: parts.balanceSol, pct };
    }
    const fixed = this.deps.config.buySizeSol;
    if (fixed != null) {
      const sizeUsd = fixed * quote.usd;
      if (!(sizeUsd > 0) || sizeUsd > HARD_CAPS.maxBuyUsd) return { ok: false, reason: "buy_size_cap" };
      return { ok: true, sizeUsd, sizeSol: fixed, confidence };
    }
    const sizeUsd = clampBuyUsd(
      sizeFromConfidence(confidence.score, this.deps.config.buySizeMinUsd, this.deps.config.buySizeMaxUsd),
    );
    if (!(sizeUsd > 0)) return { ok: false, reason: "no_price" };
    return { ok: true, sizeUsd, sizeSol: sizeUsd / quote.usd, confidence };
  }

  /** Total capital used for percent sizing, and the free SOL that can pay for a buy. */
  private async balanceParts(): Promise<{ balanceSol: number; freeSol: number }> {
    const openCost = this.deps.positions.list().reduce((sum, position) => sum + Math.max(0, position.costSol), 0);
    if (this.deps.config.mode === "paper") {
      const cash = this.deps.paperBalance?.cash() ?? 0;
      return { balanceSol: cash + openCost, freeSol: cash };
    }
    const wallet = await this.cachedWalletSol();
    const reserve = this.deps.config.liveBalanceReserveSol;
    return { balanceSol: wallet + openCost - reserve, freeSol: Math.max(0, wallet - reserve) };
  }

  /** Live wallet balance, reused for 10 seconds. */
  private async cachedWalletSol(): Promise<number> {
    const now = this.deps.now().getTime();
    if (this.walletCache && now - this.walletCache.at < WALLET_BALANCE_CACHE_MS) return this.walletCache.sol;
    const sol = await this.readBalance();
    this.walletCache = { at: now, sol };
    return sol;
  }

  /** Paper cash change from a filled buy (negative) or sell (positive). */
  private notePaperCash(delta: number): void {
    if (this.deps.config.mode !== "paper" || !Number.isFinite(delta)) return;
    this.deps.paperBalance?.add(delta);
  }

  /** Balance shown at startup when percent sizing is on. */
  async reportedBalanceSol(): Promise<number | null> {
    if (this.deps.config.buySizePctOfBalance == null) return null;
    const parts = await this.balanceParts();
    return parts.balanceSol;
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

  /** A check that does not finish inside its budget is a skip, not a buy. */
  private withinBudget<T>(work: Promise<T>, timeoutMs: number, onTimeout: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(onTimeout), timeoutMs);
    });
    return Promise.race([work, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** Realized Berlin-day PnL only. Open marks are not part of the daily stop. */
  private entriesHalted(): boolean {
    const cap = this.deps.config.maxDailyLossSol;
    if (cap == null) return false;
    const day = berlinDay(this.deps.now().toISOString());
    return this.daily.realized(this.deps.config.mode, day) <= -cap;
  }

  private noteRealized(pnl: number): void {
    if (this.deps.config.maxDailyLossSol == null) return;
    const day = berlinDay(this.deps.now().toISOString());
    this.daily.add(this.deps.config.mode, day, pnl);
    if (!this.entriesHalted()) return;
    for (const mint of [...this.watched.keys()]) this.watched.delete(mint);
  }

  private maybePauseFlat(): void {
    if (this.dailyStopWritten || !this.entriesHalted()) return;
    if (this.deps.positions.list().length > 0 || this.pendingBuys.size > 0) return;
    this.dailyStopWritten = true;
    const day = berlinDay(this.deps.now().toISOString());
    const realizedSol = this.daily.realized(this.deps.config.mode, day);
    this.deps.log.info("daily_stop", {
      realizedSol,
      day,
      mode: this.deps.config.mode,
      stopFile: this.deps.config.stopFile,
    });
    const path = this.deps.config.stopFile;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `daily_stop ${day} ${realizedSol}\n`);
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
