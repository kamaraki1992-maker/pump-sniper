import type { AppConfig } from "../config.js";
import type { TradeReason } from "../types.js";

/**
 * Momentum rules. These are fixed. `STRATEGY=sniper` does not read them.
 *
 * Approximations, called out where the public data does not match the spec:
 * - A pump.fun bonding-curve pair (`pumpfun`) is still program-owned, so the
 *   LP-burn check passes without a graduation. Its liquidity is DexScreener
 *   `liquidity.usd` when that is present, otherwise twice the wSOL reserve
 *   times the SOL price. Trades use pool `pump`. PumpSwap (`pumpswap`) is the
 *   burned-LP graduation pool and uses pool `pump-amm`. A Raydium pool passes
 *   only when this process saw the pump.fun graduation.
 * - Bundled supply is the display-token size of buys, not net of sells, in
 *   the create slot and the next two slots, from wallets other than the
 *   creator. If those early prints were not observed, the check fails closed.
 * - Unique makers, 15m buy/sell volume, and 15m buy/sell transaction counts
 *   come from one GeckoTerminal trade page (`kind` is buy or sell). DexScreener
 *   has no 15-minute bucket. A full page that does not reach the back of the
 *   window, or a row with no side, fails closed.
 * - The 5-minute run-up is DexScreener `priceChange.m5`, and also the latest
 *   5-minute candle open versus the current price when that candle exists.
 *   Either one above 60% blocks the buy.
 * - "Higher lows" means the last three closed 5m lows are strictly rising.
 * - Confidence is the average of seven 0–100 components and is only logged.
 *   A minimum-threshold metric scores 50 at the threshold and 100 at twice
 *   the threshold. A band scores 100 at its midpoint and 0 at either edge.
   *   Size is `MOMENTUM_SIZE_PCT` of available cash, capped at `MOMENTUM_MAX_USD`.
 */

export const MOMENTUM = {
  minLiquidityUsd: 10_000,
  maxTop10Pct: 25,
  maxDevPct: 4,
  maxBundlePct: 15,
  minAgeMs: 3 * 60 * 1000,
  maxAgeMs: 48 * 60 * 60 * 1000,
  minMcapUsd: 30_000,
  maxMcapUsd: 800_000,
  minVolume1hUsd: 15_000,
  volume1hToMcap: 0.3,
  maxRunup5mPct: 60,
  volumeToLiquidity: 1.5,
  buySellRatio: 1.8,
  minMakers1h: 150,
  rsiPeriod: 14,
  rsiMin: 55,
  rsiMax: 72,
  higherLowCandles: 3,
  stopDrop: 0.25,
  /** Peak gain that moves the stop from -25% to +5%. The stop never moves down. */
  lockGain: 0.4,
  lockStop: 0.05,
  staleMs: 90 * 60 * 1000,
  staleMinGain: 0.12,
  killDrawdown: 0.25,
  tp1Gain: 0.4,
  tp1OfOriginal: 0.35,
  tp2Gain: 0.9,
  tp2OfOriginal: 0.4,
  pullbackMin: 0.15,
  pullbackMax: 0.25,
  pullbackRsiPrev: 45,
  pullbackRsiMin: 40,
  pullbackRsiMax: 60,
  moonbagTrailDrop: 0.25,
  moonbagSellToBuy: 4,
  slippageMcapUsd: 150_000,
  slippageLowPct: 15,
  slippageHighPct: 8,
  minBuySol: 0.005,
} as const;

/** Incinerator. Token accounts it owns are not holder supply. */
export const BURN_OWNERS = ["1nc1nerator11111111111111111111111111111111"];

export interface Candle {
  /** Candle open time, in milliseconds. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EarlyBuy {
  slot: number;
  trader: string;
  /** Display tokens bought. Sells are not included. */
  tokens: number;
}

export interface MomentumFacts {
  nowMs: number;
  liquidityUsd: number;
  dexId: string;
  /** Raydium passes only when the feed saw this mint graduate. */
  sawGraduation: boolean;
  top10Pct: number | null;
  devPct: number | null;
  bundlePct: number | null;
  pairCreatedAtMs: number | null;
  marketCapUsd: number;
  volume5mUsd: number;
  volume1hUsd: number | null;
  buys5m: number;
  sells5m: number;
  /** Buy and sell transaction counts over the last 15 minutes. */
  buys15m: number | null;
  sells15m: number | null;
  txns15mComplete: boolean;
  /** DexScreener `priceChange.m5`, in percent. Null when the field is missing. */
  priceChange5mPct: number | null;
  /** Latest 5m candle open versus the current price, in percent. */
  candleMove5mPct: number | null;
  makers1h: number | null;
  /** False when the trade page does not cover the full hour. */
  makersComplete: boolean;
  price: number;
  candles: Candle[];
  resistanceCandles: number;
  mintOk: boolean;
  mintReason: string | null;
  /** Tiny-sell simulation. A miss is a hold. */
  honeypotOk: boolean;
  honeypotReason: string | null;
  /** At least one X, Telegram, or website link on the DexScreener pair. */
  socialsOk: boolean;
  sellVolume15mUsd: number | null;
  buyVolume15mUsd: number | null;
  volume15mComplete: boolean;
  /** Minutes of 5m candles used as the pullback high. */
  pullbackLookbackMin: number;
}

export interface MomentumDecision {
  action: "buy" | "hold";
  reason: string;
  confidence: number | null;
  entryType: "breakout" | "pullback" | null;
}

export interface MomentumExit {
  reason: TradeReason;
  /** Share of the tokens still held. */
  sellFraction: number;
}

/** Wilder RSI. Needs `period + 1` closes. Flat loss returns 100. */
export function rsi(closes: readonly number[], period = MOMENTUM.rsiPeriod): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i]! - closes[i - 1]!;
    const up = diff > 0 ? diff : 0;
    const down = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function closedCandles(candles: readonly Candle[], nowMs: number, widthMs = 5 * 60 * 1000): Candle[] {
  const bucket = Math.floor(nowMs / widthMs) * widthMs;
  return candles
    .filter((candle) => candle.ts < bucket && candle.high > 0 && candle.low > 0 && candle.close > 0)
    .sort((a, b) => a.ts - b.ts);
}

/** Last three closed lows, strictly rising. */
export function higherLows(candles: readonly Candle[], count = MOMENTUM.higherLowCandles): boolean {
  if (candles.length < count) return false;
  const tail = candles.slice(-count);
  for (let i = 1; i < tail.length; i += 1) {
    if (!(tail[i]!.low > tail[i - 1]!.low)) return false;
  }
  return true;
}

/** Max high of the prior N closed candles. */
export function localResistance(candles: readonly Candle[], count: number): number | null {
  if (!Number.isInteger(count) || count < 2 || candles.length < count) return null;
  let high = 0;
  for (const candle of candles.slice(-count)) high = Math.max(high, candle.high);
  return high > 0 ? high : null;
}

/**
 * Share of supply bought by non-creator wallets in the create slot and the
 * next two slots. Returns null when the create slot or the supply is missing.
 */
export function bundledInsiderPct(input: {
  supplyTokens: number;
  createSlot: number | null;
  creator: string | null;
  buys: readonly EarlyBuy[];
}): number | null {
  if (input.createSlot == null || !(input.supplyTokens > 0) || !input.creator) return null;
  const last = input.createSlot + 2;
  let bought = 0;
  for (const buy of input.buys) {
    if (buy.trader === input.creator) continue;
    if (buy.slot < input.createSlot || buy.slot > last) continue;
    if (buy.tokens > 0) bought += buy.tokens;
  }
  return (bought / input.supplyTokens) * 100;
}

export function momentumPool(dexId: string): "pump" | "pump-amm" | "raydium" | null {
  const id = dexId.toLowerCase();
  if (id === "pumpfun" || id === "pump.fun" || id === "pump") return "pump";
  if (id === "pumpswap" || id === "pump-amm") return "pump-amm";
  if (id === "raydium" || id === "raydium-cpmm") return "raydium";
  return null;
}

/**
 * USD liquidity for the safety check. DexScreener's figure wins. A bonding
 * curve with no USD figure uses both sides of the wSOL reserve.
 */
export function curveLiquidityUsd(quoteSol: number | null, solUsd: number | null, reportedUsd: number): number {
  if (reportedUsd > 0) return reportedUsd;
  if (quoteSol != null && quoteSol > 0 && solUsd != null && solUsd > 0) return quoteSol * solUsd * 2;
  return 0;
}

export function momentumSlippagePct(marketCapUsd: number): number {
  return marketCapUsd < MOMENTUM.slippageMcapUsd ? MOMENTUM.slippageLowPct : MOMENTUM.slippageHighPct;
}

/**
 * Momentum fee choice. Sniper tips and priority caps are not read.
 * A missing Helius estimate is charged at the cap so paper does not understate it.
 */
/** Fixed Jito tip, clamped to the momentum band. Zero when Jito is off. */
export function momentumTipSol(config: AppConfig): number {
  if (!config.momentumUseJito) return 0;
  const raw = config.momentumJitoTipSol;
  if (!(raw >= 0) || !Number.isFinite(raw)) return config.momentumJitoTipMinSol;
  return Math.min(config.momentumJitoTipMaxSol, Math.max(config.momentumJitoTipMinSol, raw));
}

export function momentumFees(
  config: AppConfig,
  turbo: boolean,
): { tipSol: number; priorityCapSol: number; feeLevel: "medium" | "high"; useJito: boolean } {
  const feeLevel = turbo ? "high" : "medium";
  const priorityCapSol = turbo ? config.momentumTurboFeeSol : config.momentumPriorityFeeSol;
  return { tipSol: momentumTipSol(config), priorityCapSol, feeLevel, useJito: config.momentumUseJito };
}

/** Live wallet SOL that can be spent. The gas reserve stays in the wallet. */
export function liveAvailableSol(walletSol: number, gasReserveUsd: number, solUsd: number): number {
  if (!(solUsd > 0) || !(walletSol > 0)) return 0;
  const reserveSol = gasReserveUsd > 0 ? gasReserveUsd / solUsd : 0;
  return Math.max(0, walletSol - reserveSol);
}

export function clampPriorityFee(estimateSol: number, capSol: number): number {
  if (!(estimateSol >= 0) || !Number.isFinite(estimateSol)) return capSol;
  return Math.min(estimateSol, capSol);
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** 50 at the threshold, 100 at twice the threshold. */
function clearanceScore(value: number, threshold: number): number {
  if (!(threshold > 0) || !Number.isFinite(value)) return 0;
  return clampScore((50 * value) / threshold);
}

/** 100 at the midpoint, 0 at either edge. */
function bandScore(value: number, min: number, max: number): number {
  if (!(max > min) || !Number.isFinite(value)) return 0;
  const mid = (min + max) / 2;
  const half = (max - min) / 2;
  return clampScore(100 * (1 - Math.abs(value - mid) / half));
}

export function momentumConfidence(facts: MomentumFacts, candles: readonly Candle[]): number | null {
  const ratio = facts.sells5m > 0 ? facts.buys5m / facts.sells5m : facts.buys5m > 0 ? Number.POSITIVE_INFINITY : 0;
  const volumeRatio = facts.liquidityUsd > 0 ? facts.volume5mUsd / facts.liquidityUsd : 0;
  const resistance = localResistance(candles, facts.resistanceCandles);
  const closes = candles.map((candle) => candle.close);
  const rsiValue = rsi(closes);
  if (facts.makers1h == null || resistance == null || rsiValue == null || !(facts.price > 0)) return null;
  const breakout = clampScore(((facts.price / resistance - 1) / 0.02) * 100);
  const parts = [
    bandScore(facts.marketCapUsd, MOMENTUM.minMcapUsd, MOMENTUM.maxMcapUsd),
    clearanceScore(volumeRatio, MOMENTUM.volumeToLiquidity),
    clearanceScore(ratio, MOMENTUM.buySellRatio),
    clearanceScore(facts.makers1h, MOMENTUM.minMakers1h),
    higherLows(candles) ? 100 : 0,
    breakout,
    bandScore(rsiValue, MOMENTUM.rsiMin, MOMENTUM.rsiMax),
  ];
  const avg = parts.reduce((sum, part) => sum + part, 0) / parts.length;
  return Math.round(avg * 10) / 10;
}

function authorityReason(reason: string | null): boolean {
  return reason === "mint-authority-set" || reason === "freeze-authority-set";
}

/** First failing safety check, or null when every check passes. */
export function momentumSafety(facts: MomentumFacts): string | null {
  if (!facts.mintOk) {
    if (authorityReason(facts.mintReason)) return facts.mintReason ?? "mint_authority";
    if (facts.mintReason === "transfer-fee" || facts.mintReason === "transfer-hook") return facts.mintReason;
    return facts.mintReason ?? "token_program";
  }
  if (!facts.honeypotOk) return facts.honeypotReason ?? "honeypot";
  if (!facts.socialsOk) return "no_socials";
  if (!(facts.liquidityUsd >= MOMENTUM.minLiquidityUsd)) return "liquidity";
  const pool = momentumPool(facts.dexId);
  if (!pool) return "lp_not_canonical";
  if (pool === "raydium" && !facts.sawGraduation) return "lp_not_canonical";
  if (facts.top10Pct == null) return "top10_unavailable";
  if (!(facts.top10Pct < MOMENTUM.maxTop10Pct)) return "top10";
  if (facts.devPct == null) return "dev_unknown";
  if (!(facts.devPct < MOMENTUM.maxDevPct)) return "dev_wallet";
  if (facts.bundlePct == null) return "bundle_unknown";
  if (!(facts.bundlePct < MOMENTUM.maxBundlePct)) return "bundle";
  if (facts.pairCreatedAtMs == null) return "age_unknown";
  const age = facts.nowMs - facts.pairCreatedAtMs;
  if (age < MOMENTUM.minAgeMs) return "too_young";
  if (age >= MOMENTUM.maxAgeMs) return "too_old";
  return null;
}

/** $15k in the last hour, or more than 30% of market cap. */
export function hourVolumeOk(volume1hUsd: number, marketCapUsd: number): boolean {
  return (
    volume1hUsd >= MOMENTUM.minVolume1hUsd ||
    (marketCapUsd > 0 && volume1hUsd > marketCapUsd * MOMENTUM.volume1hToMcap)
  );
}

/** Market cap, hour volume, 15-minute transaction pressure, and the 60% run-up cap. */
export function momentumSharedEntry(facts: MomentumFacts): string | null {
  if (!(facts.marketCapUsd >= MOMENTUM.minMcapUsd && facts.marketCapUsd <= MOMENTUM.maxMcapUsd)) return "mcap";
  if (facts.volume1hUsd == null) return "volume_1h_unavailable";
  if (!hourVolumeOk(facts.volume1hUsd, facts.marketCapUsd)) return "volume_1h";
  if (!facts.txns15mComplete || facts.buys15m == null || facts.sells15m == null) return "txns_15m_unavailable";
  if (!(facts.buys15m > facts.sells15m)) return "txns_15m";
  const runup = fiveMinuteRunupPct(facts.priceChange5mPct, facts.candleMove5mPct);
  if (runup == null) return "fomo_unavailable";
  if (runup > MOMENTUM.maxRunup5mPct) return "fomo";
  return null;
}

/** Breakout-only triggers. Null when every one holds. */
export function momentumBreakout(facts: MomentumFacts, candles: readonly Candle[]): string | null {
  if (!(facts.liquidityUsd > 0) || !(facts.volume5mUsd >= facts.liquidityUsd * MOMENTUM.volumeToLiquidity)) {
    return "volume";
  }
  const ratio = facts.sells5m > 0 ? facts.buys5m / facts.sells5m : facts.buys5m > 0 ? Number.POSITIVE_INFINITY : 0;
  if (!(ratio > MOMENTUM.buySellRatio)) return "buy_sell_ratio";
  if (facts.makers1h == null) return "makers_unavailable";
  if (!facts.makersComplete && facts.makers1h < MOMENTUM.minMakers1h) return "makers_incomplete";
  if (!(facts.makers1h >= MOMENTUM.minMakers1h)) return "makers";
  if (!higherLows(candles)) return "higher_lows";
  const resistance = localResistance(candles, facts.resistanceCandles);
  if (resistance == null) return "resistance_history";
  if (!(facts.price > resistance)) return "resistance";
  const value = rsi(candles.map((candle) => candle.close));
  if (value == null) return "rsi_history";
  if (!(value >= MOMENTUM.rsiMin && value <= MOMENTUM.rsiMax)) return "rsi";
  return null;
}

/** Max high of the 5m candles whose open is inside the lookback. */
export function pullbackHigh(candles: readonly Candle[], nowMs: number, lookbackMin: number): number | null {
  const start = nowMs - lookbackMin * 60 * 1000;
  let high = 0;
  for (const candle of candles) {
    if (candle.ts < start) continue;
    if (candle.high > high) high = candle.high;
  }
  return high > 0 ? high : null;
}

/** True when price is between 15% and 25% under `high`, inclusive. */
export function inPullbackBand(price: number, high: number): boolean {
  if (!(price > 0) || !(high > price)) return false;
  const drop = (high - price) / high;
  return drop + 1e-9 >= MOMENTUM.pullbackMin && drop <= MOMENTUM.pullbackMax + 1e-9;
}

/** Previous closed RSI was at or under 45, and the latest RSI is higher and inside 40–60. */
export function rsiBounce(previous: number | null, current: number | null): boolean {
  if (previous == null || current == null) return false;
  return (
    previous <= MOMENTUM.pullbackRsiPrev &&
    current > previous &&
    current >= MOMENTUM.pullbackRsiMin &&
    current <= MOMENTUM.pullbackRsiMax
  );
}

/** Pullback-only triggers. Null when every one holds. */
export function momentumPullback(facts: MomentumFacts, candles: readonly Candle[]): string | null {
  const high = pullbackHigh(facts.candles, facts.nowMs, facts.pullbackLookbackMin);
  if (high == null) return "pullback_history";
  if (!inPullbackBand(facts.price, high)) return "pullback_band";
  if (!facts.volume15mComplete || facts.buyVolume15mUsd == null || facts.sellVolume15mUsd == null) {
    return "volume_15m_unavailable";
  }
  if (!(facts.buyVolume15mUsd > facts.sellVolume15mUsd)) return "volume_15m";
  const closes = candles.map((candle) => candle.close);
  if (closes.length < MOMENTUM.rsiPeriod + 2) return "rsi_bounce_history";
  const previous = rsi(closes.slice(0, -1));
  const current = rsi(closes);
  if (!rsiBounce(previous, current)) return "rsi_bounce";
  return null;
}

export function evaluateMomentum(facts: MomentumFacts): MomentumDecision {
  const candles = closedCandles(facts.candles, facts.nowMs);
  const confidence = momentumConfidence({ ...facts, candles }, candles);
  const safety = momentumSafety(facts);
  if (safety) return { action: "hold", reason: safety, confidence, entryType: null };
  const shared = momentumSharedEntry(facts);
  if (shared) return { action: "hold", reason: shared, confidence, entryType: null };
  const breakout = momentumBreakout(facts, candles);
  if (!breakout) return { action: "buy", reason: "breakout", confidence, entryType: "breakout" };
  const pullback = momentumPullback(facts, candles);
  if (!pullback) return { action: "buy", reason: "pullback", confidence, entryType: "pullback" };
  return { action: "hold", reason: breakout, confidence, entryType: null };
}

export function momentumSize(input: {
  /** Cash that is not in a position. Paper cash is already tradable; live cash is net of the gas reserve. */
  availableSol: number;
  solUsd: number;
  sizePct: number;
  maxUsd: number;
}): { ok: true; sizeSol: number; sizeUsd: number; pct: number } | { ok: false; reason: string } {
  if (!(input.solUsd > 0) || !(input.availableSol > 0) || !(input.sizePct > 0) || !(input.maxUsd > 0)) {
    return { ok: false, reason: "no_price" };
  }
  const pct = input.sizePct;
  const rawUsd = input.availableSol * (pct / 100) * input.solUsd;
  const sizeUsd = Math.min(rawUsd, input.maxUsd);
  const sizeSol = sizeUsd / input.solUsd;
  if (!(sizeSol >= MOMENTUM.minBuySol)) return { ok: false, reason: "buy_size_min" };
  return { ok: true, sizeSol, sizeUsd, pct };
}

/**
 * The larger of DexScreener's 5-minute change and the latest candle's
 * open-to-current move. Null when neither is available.
 */
export function fiveMinuteRunupPct(dexPct: number | null, candlePct: number | null): number | null {
  if (dexPct == null && candlePct == null) return null;
  return Math.max(dexPct ?? Number.NEGATIVE_INFINITY, candlePct ?? Number.NEGATIVE_INFINITY);
}

/** Open of the newest 5m candle versus `price`, when that candle is recent. */
export function candleMove5mPct(candles: readonly Candle[], nowMs: number, price: number): number | null {
  if (!(price > 0) || candles.length === 0) return null;
  let latest = candles[0]!;
  for (const candle of candles) if (candle.ts >= latest.ts) latest = candle;
  if (!(latest.open > 0) || nowMs - latest.ts > 10 * 60 * 1000) return null;
  return ((price - latest.open) / latest.open) * 100;
}

/** Stop price from the peak. Once +40% has printed, the floor is +5% and does not fall. */
export function momentumStopPrice(entryPriceSol: number, peakPriceSol: number): number {
  const peak = Math.max(peakPriceSol, entryPriceSol);
  const peakGain = entryPriceSol > 0 ? (peak - entryPriceSol) / entryPriceSol : 0;
  if (peakGain + 1e-9 >= MOMENTUM.lockGain) return entryPriceSol * (1 + MOMENTUM.lockStop);
  return entryPriceSol * (1 - MOMENTUM.stopDrop);
}

/** Share of the tokens still held that equals `ofOriginal` of the original position. */
export function originalFraction(ofOriginal: number, alreadySold: number): number {
  const remaining = 1 - alreadySold;
  if (!(remaining > 0)) return 1;
  return Math.min(1, ofOriginal / remaining);
}

/**
 * Exits in order. One call returns one exit. Take-profits are fractions of
 * the original position: 35% at +40% and 40% at +90%. The last 25% is the moonbag.
 */
export function momentumExit(input: {
  entryPriceSol: number;
  peakPriceSol: number;
  priceSol: number;
  tp1Taken: boolean;
  tp2Taken: boolean;
  sellVolume15mUsd: number | null;
  buyVolume15mUsd: number | null;
  volume15mComplete: boolean;
  openedAtMs?: number;
  nowMs?: number;
}): MomentumExit | null {
  const entry = input.entryPriceSol;
  const price = input.priceSol;
  if (!(entry > 0) || !(price > 0)) return null;
  const peak = Math.max(input.peakPriceSol, price);
  if (price <= momentumStopPrice(entry, peak)) return { reason: "momentum_sl", sellFraction: 1 };
  if (!input.tp1Taken && price >= entry * (1 + MOMENTUM.tp1Gain)) {
    return { reason: "momentum_tp1", sellFraction: originalFraction(MOMENTUM.tp1OfOriginal, 0) };
  }
  if (input.tp1Taken && !input.tp2Taken && price >= entry * (1 + MOMENTUM.tp2Gain)) {
    return { reason: "momentum_tp2", sellFraction: originalFraction(MOMENTUM.tp2OfOriginal, MOMENTUM.tp1OfOriginal) };
  }
  if (input.tp1Taken && input.tp2Taken) {
    if (price <= peak * (1 - MOMENTUM.moonbagTrailDrop)) return { reason: "momentum_moonbag", sellFraction: 1 };
    const buy = input.buyVolume15mUsd;
    const sell = input.sellVolume15mUsd;
    if (input.volume15mComplete && sell != null && buy != null && sell > buy * MOMENTUM.moonbagSellToBuy) {
      return { reason: "momentum_moonbag", sellFraction: 1 };
    }
  }
  if (input.openedAtMs != null && input.nowMs != null && input.nowMs - input.openedAtMs >= MOMENTUM.staleMs) {
    const peakGain = (peak - entry) / entry;
    if (peakGain + 1e-9 < MOMENTUM.staleMinGain) return { reason: "momentum_stale", sellFraction: 1 };
  }
  return null;
}
