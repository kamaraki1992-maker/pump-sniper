import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { Mode } from "./types.js";

/**
 * Caps live in code on purpose. Env values outside these bounds abort startup.
 * Loosening them means editing this object.
 */
export const HARD_CAPS = {
  maxBuyUsd: 30,
  maxSlippagePct: 20,
  minJitoTipSol: 0.0005,
  maxJitoTipSol: 0.005,
  maxCreatorHoldPct: 10,
  maxTop10Pct: 100,
  maxOpenPositions: 5,
  maxTp1Pct: 500,
  maxStopLossPct: 20,
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface PaperModel {
  slippagePct: number;
  protocolFeeBps: number;
  venueFeeBps: number;
  priorityFeeSol: number;
  baseFeeSol: number;
  jitoTipSol: number;
}

export interface AppConfig {
  mode: Mode;
  buySizeMinUsd: number;
  buySizeMaxUsd: number;
  /** Buy cap. Also the value used when older code reads a single slippage. */
  maxSlippagePct: number;
  buySlippagePct: number;
  sellSlippagePct: number;
  stopLossPct: number;
  /** Peak gain that arms the trail. The stop then sits at break-even or tighter. */
  trailActivatePct: number;
  /** Percent below the peak. The stop is max(entry, peak * (1 - distance)). */
  trailDistancePct: number;
  /** Gain that sells `tp1SellFraction` once. The rest rides the trail. */
  tp1Pct: number;
  tp1SellFraction: number;
  /** TRAIL_TIERS was set. It is not applied. */
  ignoredTrailTiers: boolean;
  /** TAKE_PROFIT_PCT was set. The full take profit is not applied. */
  ignoredTakeProfit: boolean;
  /** Fixed tip when `tipMode` is `fixed`. Dynamic mode still stores the minimum. */
  jitoTipSol: number;
  tipMode: "dynamic" | "fixed";
  jitoTipPct: number;
  jitoTipMinSol: number;
  jitoTipMaxSol: number;
  /** Set when BUY_SIZE_SOL is set. Overrides USD confidence sizing. */
  buySizeSol: number | null;
  /** When set, each buy is this percent of total balance. Overrides BUY_SIZE_SOL and USD sizing. */
  buySizePctOfBalance: number | null;
  /** Required in paper mode when percent sizing is on. */
  paperStartBalanceSol: number | null;
  /** SOL held back from the live wallet before percent sizing. */
  liveBalanceReserveSol: number;
  entryWatchMinSec: number;
  entryWatchMaxSec: number;
  entryMinBuys: number;
  entryMinUniqueBuyers: number;
  entryMinNetBuySol: number;
  /** When set with `entryEarlyMinNetBuySol`, an earlier pass can buy before the watch ends. */
  entryEarlySec: number | null;
  entryEarlyMinNetBuySol: number | null;
  /** 0–100 confidence gate. Unset means the gate is off. */
  minEntryScore: number | null;
  entryMinBuyRatio: number;
  entryMaxRunupPct: number;
  entryMaxWatched: number;
  /** When set, entry buckets use this width. Otherwise each bucket is one third of the watch so far. */
  entryBucketSec: number | null;
  /** Realized daily loss that stops new entries. Unset means the limit is off. */
  maxDailyLossSol: number | null;
  /** When true, a create must publish a well-formed Twitter/X and/or Telegram link. */
  requireSocials: boolean;
  /** When true with REQUIRE_SOCIALS, a socials miss can still enter. */
  allowNoSocialsEntry: boolean;
  /** Time stop for no-socials positions. Required when the fast lane is on. */
  noSocialsTimeStopSec: number | null;
  noSocialsMinGainPct: number | null;
  /** `any` accepts either network. `both` requires each. */
  requireSocialsMode: "any" | "both";
  metadataTimeoutMs: number;
  /** Retry metadata until the watch deadline. A loaded JSON body is never retried. */
  metadataRetry: boolean;
  /** Per-attempt metadata timeout. */
  metadataAttemptTimeoutMs: number;
  /** Retry budget. Null uses the entry watch window. */
  metadataRetryDeadlineSec: number | null;
  /** Unset means the profit lock is off. */
  profitLockTriggerPct: number | null;
  profitLockFloorPct: number | null;
  /** A print this far below the previous mark exits immediately. */
  stopFastDropPct: number;
  devSellExit: boolean;
  earlyExitMinGainPct: number;
  /** 0 disables the early-momentum exit. */
  earlyExitWindowSec: number;
  /** Ignore a sharp drop for this long after a fill. Null disables the guard. */
  postBuyGuardMs: number | null;
  /** Drop, in percent below entry, that the post-buy guard ignores. */
  postBuyGuardDropPct: number | null;
  priorityFeeSol: number;
  /** Total priority-fee clamp for one transaction, in lamports. */
  priorityFeeMaxLamports: number;
  /** How long a Helius or recent-fee sample is reused. */
  priorityFeeCacheMs: number;
  creatorMaxHoldPct: number;
  /** Skip a buy when the filtered top 10 own more than this percent of supply. */
  maxTop10Pct: number;
  /** Shared Helius token-bucket rate, in requests per second. */
  heliusRps: number;
  /** Budget for the top-10 and creator-history checks. A miss skips the buy. */
  rugCheckTimeoutMs: number;
  /** Successful read RPCs are reused for this long. */
  rpcCacheTtlMs: number;
  maxOpenPositions: number;
  maxHoldMinutes: number;
  liqDropPct: number;
  volumeStallSec: number;
  /** No-trade time before this many seconds after entry does not count as a stall. */
  volumeStallGraceSec: number;
  sellPressureRatio: number;
  sellPressureWindowSec: number;
  safetyCheckTimeoutMs: number;
  /** Set only when both GRPC_URL and GRPC_TOKEN are present. The token itself is not stored here. */
  grpcUrl: string | null;
  /** Present only when RPC_WS_URL is set. Logs must redact its api-key. */
  rpcWsUrl: string | null;
  /** Market-data socket. `pumpportal` and `pumpdev` remain available. Orders still use `tradeApiUrl`. */
  feed: "helius" | "pumpportal" | "pumpdev";
  /** Reconnect the Helius log feed after this many seconds without a logs notification. */
  feedStallSec: number;
  dataWsUrl: string;
  wsUrl: string;
  tradeApiUrl: string;
  rpcUrl: string;
  /** Top-10 and mint-authority reads. Falls back to `rpcUrl` when unset. */
  rugCheckRpcUrl: string;
  jitoBlockEngineUrl: string;
  solPriceUrl: string;
  dataDir: string;
  tradesPath: string;
  positionsPath: string;
  stopFile: string;
  confirmTimeoutMs: number;
  sellMaxAttempts: number;
  paper: PaperModel;
}

function optionalNum(value: string | undefined, name: string): number | null {
  if (value === undefined || value.trim() === "") return null;
  return num(value, 0, name);
}

function num(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${name} must be a finite number`);
  }
  return parsed;
}

/** `JITO_TIP_LAMPORTS` wins when it is set. Otherwise `JITO_TIP_SOL`, default 0.002. */
function jitoTipFromEnv(env: NodeJS.ProcessEnv): number {
  const lamports = env.JITO_TIP_LAMPORTS;
  if (lamports !== undefined && lamports.trim() !== "") {
    const parsed = Number(lamports);
    if (!Number.isFinite(parsed)) throw new ConfigError("JITO_TIP_LAMPORTS must be a finite number");
    return parsed / 1e9;
  }
  return num(env.JITO_TIP_SOL, 0.002, "JITO_TIP_SOL");
}

/** `MAX_CREATOR_HOLD_PCT` wins. `CREATOR_MAX_HOLD_PCT` remains as a fallback. */
function creatorHoldRaw(env: NodeJS.ProcessEnv): string | undefined {
  if (env.MAX_CREATOR_HOLD_PCT !== undefined && env.MAX_CREATOR_HOLD_PCT.trim() !== "") {
    return env.MAX_CREATOR_HOLD_PCT;
  }
  return env.CREATOR_MAX_HOLD_PCT;
}

function str(value: string | undefined, fallback: string): string {
  if (value === undefined || value.trim() === "") return fallback;
  return value.trim();
}

/** Decode and discard. Errors never include the secret. */
export function assertLiveKey(secret: string): void {
  try {
    const bytes = bs58.decode(secret.trim());
    if (bytes.length !== 64) {
      throw new Error("bad length");
    }
    Keypair.fromSecretKey(bytes);
  } catch {
    throw new ConfigError("PRIVATE_KEY is not a valid base58 secret key");
  }
}

/**
 * SOL that must be free before a live buy. Each open position still needs a
 * later sell (priority fee, base fee, and tip), and this order needs the same
 * plus its size.
 */
/** Clamp a computed USD notional to the hard cap. Non-positive values become 0. */
export function clampBuyUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.min(usd, HARD_CAPS.maxBuyUsd);
}

/** SOL reserved for the priority fee. The dynamic quote can rise to the lamport clamp. */
export function reservedPriorityFeeSol(config: AppConfig): number {
  return Math.max(config.priorityFeeSol, config.priorityFeeMaxLamports / 1e9);
}

/** Worst-case tip reserved for a live buy. Dynamic mode reserves the configured maximum. */
export function reservedTipSol(config: AppConfig): number {
  return config.tipMode === "dynamic" ? config.jitoTipMaxSol : config.jitoTipSol;
}

export function requiredBuyBalanceSol(config: AppConfig, buySize: number, openPositions = 0): number {
  const txFee = reservedPriorityFeeSol(config) + config.paper.baseFeeSol;
  const tip = reservedTipSol(config);
  const exitReserve = txFee + tip;
  return buySize + txFee + tip + exitReserve + openPositions * exitReserve;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode: Mode = env.MODE === "live" ? "live" : "paper";
  const buySizeMinUsd = num(env.BUY_SIZE_MIN_USD, 5, "BUY_SIZE_MIN_USD");
  const buySizeMaxUsd = num(env.BUY_SIZE_MAX_USD, HARD_CAPS.maxBuyUsd, "BUY_SIZE_MAX_USD");
  const legacySlippage = optionalNum(env.MAX_SLIPPAGE_PCT, "MAX_SLIPPAGE_PCT");
  const buySlippagePct = optionalNum(env.BUY_SLIPPAGE_PCT, "BUY_SLIPPAGE_PCT") ?? legacySlippage ?? 5;
  const sellSlippagePct = optionalNum(env.SELL_SLIPPAGE_PCT, "SELL_SLIPPAGE_PCT") ?? legacySlippage ?? 10;
  const legacyTip = jitoTipFromEnv(env);
  const tipKeysSet =
    (env.JITO_TIP_PCT !== undefined && env.JITO_TIP_PCT.trim() !== "") ||
    (env.JITO_TIP_MIN_SOL !== undefined && env.JITO_TIP_MIN_SOL.trim() !== "") ||
    (env.JITO_TIP_MAX_SOL !== undefined && env.JITO_TIP_MAX_SOL.trim() !== "");
  const legacyExplicit =
    (env.JITO_TIP_SOL !== undefined && env.JITO_TIP_SOL.trim() !== "") ||
    (env.JITO_TIP_LAMPORTS !== undefined && env.JITO_TIP_LAMPORTS.trim() !== "");
  const tipMode: "dynamic" | "fixed" = tipKeysSet || !legacyExplicit ? "dynamic" : "fixed";
  const jitoTipPct = num(env.JITO_TIP_PCT, 0.01, "JITO_TIP_PCT");
  const jitoTipMinSol = num(env.JITO_TIP_MIN_SOL, HARD_CAPS.minJitoTipSol, "JITO_TIP_MIN_SOL");
  const jitoTipMaxSol = num(env.JITO_TIP_MAX_SOL, 0.0015, "JITO_TIP_MAX_SOL");
  const jitoTipSol = tipMode === "fixed" ? legacyTip : jitoTipMinSol;
  const buySizeSol = optionalNum(env.BUY_SIZE_SOL, "BUY_SIZE_SOL");
  const buySizePctOfBalance = optionalNum(env.BUY_SIZE_PCT_OF_BALANCE, "BUY_SIZE_PCT_OF_BALANCE");
  const paperStartBalanceSol = optionalNum(env.PAPER_START_BALANCE_SOL, "PAPER_START_BALANCE_SOL");
  const liveBalanceReserveSol = num(env.LIVE_BALANCE_RESERVE_SOL, 0.02, "LIVE_BALANCE_RESERVE_SOL");
  const entryWatchMinSec = num(env.ENTRY_WATCH_MIN_SEC, 15, "ENTRY_WATCH_MIN_SEC");
  const entryWatchMaxSec = num(env.ENTRY_WATCH_MAX_SEC, 30, "ENTRY_WATCH_MAX_SEC");
  const entryMinBuys = num(env.ENTRY_MIN_BUYS, 8, "ENTRY_MIN_BUYS");
  const entryMinUniqueBuyers = num(env.ENTRY_MIN_UNIQUE_BUYERS, 5, "ENTRY_MIN_UNIQUE_BUYERS");
  const entryMinNetBuySol = num(env.ENTRY_MIN_NET_BUY_SOL, 1, "ENTRY_MIN_NET_BUY_SOL");
  const entryEarlySec = optionalNum(env.ENTRY_EARLY_SEC, "ENTRY_EARLY_SEC");
  const entryEarlyMinNetBuySol = optionalNum(env.ENTRY_EARLY_MIN_NET_BUY_SOL, "ENTRY_EARLY_MIN_NET_BUY_SOL");
  const minEntryScore = optionalNum(env.MIN_ENTRY_SCORE, "MIN_ENTRY_SCORE");
  const entryMinBuyRatio = num(env.ENTRY_MIN_BUY_RATIO, 0.6, "ENTRY_MIN_BUY_RATIO");
  const entryMaxRunupPct = num(env.ENTRY_MAX_RUNUP_PCT, 60, "ENTRY_MAX_RUNUP_PCT");
  const entryMaxWatched = num(env.ENTRY_MAX_WATCHED, 30, "ENTRY_MAX_WATCHED");
  const entryBucketSec = optionalNum(env.ENTRY_BUCKET_SEC, "ENTRY_BUCKET_SEC");
  const maxDailyLossSol = optionalNum(env.MAX_DAILY_LOSS_SOL, "MAX_DAILY_LOSS_SOL");
  const requireSocials = env.REQUIRE_SOCIALS === "true" || env.REQUIRE_SOCIALS === "1";
  const allowNoSocialsEntry = env.ALLOW_NO_SOCIALS_ENTRY === "true" || env.ALLOW_NO_SOCIALS_ENTRY === "1";
  const noSocialsTimeStopSec = optionalNum(env.NO_SOCIALS_TIME_STOP_SEC, "NO_SOCIALS_TIME_STOP_SEC");
  const noSocialsMinGainPct = optionalNum(env.NO_SOCIALS_MIN_GAIN_PCT, "NO_SOCIALS_MIN_GAIN_PCT");
  const socialModeRaw = (env.REQUIRE_SOCIALS_MODE ?? "").trim().toLowerCase();
  const requireSocialsMode: "any" | "both" = socialModeRaw === "" ? "any" : socialModeRaw === "both" ? "both" : socialModeRaw === "any" ? "any" : "any";
  if (socialModeRaw !== "" && socialModeRaw !== "any" && socialModeRaw !== "both") {
    throw new ConfigError("REQUIRE_SOCIALS_MODE must be any or both");
  }
  if (allowNoSocialsEntry && (!(noSocialsTimeStopSec != null && noSocialsTimeStopSec > 0) || !(noSocialsMinGainPct != null && noSocialsMinGainPct > 0))) {
    throw new ConfigError("NO_SOCIALS_TIME_STOP_SEC and NO_SOCIALS_MIN_GAIN_PCT must be > 0 when ALLOW_NO_SOCIALS_ENTRY is on");
  }
  const metadataTimeoutMs = num(env.METADATA_TIMEOUT_MS, 2_500, "METADATA_TIMEOUT_MS");
  const metadataRetry = env.METADATA_RETRY === undefined || env.METADATA_RETRY.trim() === ""
    ? true
    : env.METADATA_RETRY.trim() !== "false" && env.METADATA_RETRY.trim() !== "0";
  const metadataAttemptTimeoutMs = num(env.METADATA_ATTEMPT_TIMEOUT_MS, 1_200, "METADATA_ATTEMPT_TIMEOUT_MS");
  const metadataRetryDeadlineSec = optionalNum(env.METADATA_RETRY_DEADLINE_SEC, "METADATA_RETRY_DEADLINE_SEC");
  const profitLockTriggerPct = optionalNum(env.PROFIT_LOCK_TRIGGER_PCT, "PROFIT_LOCK_TRIGGER_PCT");
  const profitLockFloorPct = optionalNum(env.PROFIT_LOCK_FLOOR_PCT, "PROFIT_LOCK_FLOOR_PCT");
  const stopFastDropPct = num(env.STOP_FAST_DROP_PCT, 12, "STOP_FAST_DROP_PCT");
  const devSellExit = env.DEV_SELL_EXIT === undefined || env.DEV_SELL_EXIT.trim() === ""
    ? true
    : env.DEV_SELL_EXIT.trim() !== "false" && env.DEV_SELL_EXIT.trim() !== "0";
  const earlyExitMinGainPct = num(env.EARLY_EXIT_MIN_GAIN_PCT, 10, "EARLY_EXIT_MIN_GAIN_PCT");
  const earlyExitWindowSec = num(env.EARLY_EXIT_WINDOW_SEC, 5, "EARLY_EXIT_WINDOW_SEC");
  const postBuyGuardMs = optionalNum(env.POST_BUY_GUARD_MS, "POST_BUY_GUARD_MS");
  const postBuyGuardDropPct = optionalNum(env.POST_BUY_GUARD_DROP_PCT, "POST_BUY_GUARD_DROP_PCT");
  const heliusStallExplicit = (env.HELIUS_STALL_SEC ?? "").trim() !== "";
  const feedStallSec = heliusStallExplicit
    ? num(env.HELIUS_STALL_SEC, 30, "HELIUS_STALL_SEC")
    : num(env.FEED_STALL_SEC, 30, "FEED_STALL_SEC");
  const stopLossPct = num(env.STOP_LOSS_PCT, HARD_CAPS.maxStopLossPct, "STOP_LOSS_PCT");
  const trailActivatePct = num(env.TRAIL_ACTIVATE_PCT, 50, "TRAIL_ACTIVATE_PCT");
  const trailDistancePct = num(env.TRAIL_DISTANCE_PCT, 20, "TRAIL_DISTANCE_PCT");
  const tp1Pct = num(env.TP1_PCT, 100, "TP1_PCT");
  const tp1SellFraction = num(env.TP1_SELL_FRACTION, 0.5, "TP1_SELL_FRACTION");
  const ignoredTrailTiers = Boolean(env.TRAIL_TIERS?.trim());
  const ignoredTakeProfit = Boolean(env.TAKE_PROFIT_PCT?.trim());
  const priorityFeeSol = num(env.PRIORITY_FEE_SOL, 0.00005, "PRIORITY_FEE_SOL");
  const priorityFeeMaxLamports = num(env.PRIORITY_FEE_MAX_LAMPORTS, 500_000, "PRIORITY_FEE_MAX_LAMPORTS");
  const priorityFeeCacheMs = num(env.PRIORITY_FEE_CACHE_MS, 5_000, "PRIORITY_FEE_CACHE_MS");
  const creatorMaxHoldPct = num(creatorHoldRaw(env), 5, "MAX_CREATOR_HOLD_PCT");
  const maxTop10Pct = num(env.MAX_TOP10_PCT, 25, "MAX_TOP10_PCT");
  const heliusRps = num(env.HELIUS_RPS, 5, "HELIUS_RPS");
  const rugCheckTimeoutMs = num(env.RUG_CHECK_TIMEOUT_MS, 2_000, "RUG_CHECK_TIMEOUT_MS");
  const rpcCacheTtlMs = num(env.RPC_CACHE_TTL_MS, 3_000, "RPC_CACHE_TTL_MS");
  const maxOpenPositions = num(env.MAX_OPEN_POSITIONS, HARD_CAPS.maxOpenPositions, "MAX_OPEN_POSITIONS");
  const maxHoldMinutes = num(env.MAX_HOLD_MINUTES, 10, "MAX_HOLD_MINUTES");
  const liqDropPct = num(env.LIQ_DROP_PCT, 20, "LIQ_DROP_PCT");
  const volumeStallSec = num(env.VOLUME_STALL_SEC, 45, "VOLUME_STALL_SEC");
  const volumeStallGraceSec = num(env.VOLUME_STALL_GRACE_SEC, 90, "VOLUME_STALL_GRACE_SEC");
  const sellPressureRatio = num(env.SELL_PRESSURE_RATIO, 3, "SELL_PRESSURE_RATIO");
  const sellPressureWindowSec = num(env.SELL_PRESSURE_WINDOW_SEC, 30, "SELL_PRESSURE_WINDOW_SEC");
  const safetyCheckTimeoutMs = num(env.SAFETY_CHECK_TIMEOUT_MS, 250, "SAFETY_CHECK_TIMEOUT_MS");
  const grpcUrlRaw = str(env.GRPC_URL, "");
  const grpcTokenPresent = Boolean(env.GRPC_TOKEN?.trim());
  const paperSlippagePct = num(env.PAPER_SLIPPAGE_PCT, 2, "PAPER_SLIPPAGE_PCT");
  const protocolFeeBps = num(env.PAPER_PROTOCOL_FEE_BPS, 100, "PAPER_PROTOCOL_FEE_BPS");
  const venueFeeBps = num(env.PAPER_VENUE_FEE_BPS, 25, "PAPER_VENUE_FEE_BPS");
  const baseFeeSol = num(env.PAPER_BASE_FEE_SOL, 0.000005, "PAPER_BASE_FEE_SOL");

  if (!(buySizeMinUsd > 0) || buySizeMinUsd > HARD_CAPS.maxBuyUsd) {
    throw new ConfigError(
      `BUY_SIZE_MIN_USD ${buySizeMinUsd} exceeds hard cap ${HARD_CAPS.maxBuyUsd}`,
    );
  }
  if (!(buySizeMaxUsd > 0) || buySizeMaxUsd > HARD_CAPS.maxBuyUsd || buySizeMaxUsd < buySizeMinUsd) {
    throw new ConfigError(
      `BUY_SIZE_MAX_USD ${buySizeMaxUsd} exceeds hard cap ${HARD_CAPS.maxBuyUsd}`,
    );
  }
  if (!(buySlippagePct > 0) || buySlippagePct > HARD_CAPS.maxSlippagePct) {
    throw new ConfigError(
      `BUY_SLIPPAGE_PCT ${buySlippagePct} exceeds hard cap ${HARD_CAPS.maxSlippagePct}`,
    );
  }
  if (!(sellSlippagePct > 0) || sellSlippagePct > HARD_CAPS.maxSlippagePct) {
    throw new ConfigError(
      `SELL_SLIPPAGE_PCT ${sellSlippagePct} exceeds hard cap ${HARD_CAPS.maxSlippagePct}`,
    );
  }
  if (tipMode === "fixed" && (jitoTipSol < HARD_CAPS.minJitoTipSol || jitoTipSol > HARD_CAPS.maxJitoTipSol)) {
    throw new ConfigError(
      `JITO_TIP_SOL ${jitoTipSol} is outside hard bounds ${HARD_CAPS.minJitoTipSol}-${HARD_CAPS.maxJitoTipSol}`,
    );
  }
  if (!(jitoTipPct > 0) || jitoTipPct > 0.05) {
    throw new ConfigError("JITO_TIP_PCT must be between 0 and 0.05");
  }
  if (jitoTipMinSol < HARD_CAPS.minJitoTipSol || jitoTipMinSol > HARD_CAPS.maxJitoTipSol) {
    throw new ConfigError(
      `JITO_TIP_MIN_SOL ${jitoTipMinSol} is outside hard bounds ${HARD_CAPS.minJitoTipSol}-${HARD_CAPS.maxJitoTipSol}`,
    );
  }
  if (jitoTipMaxSol < jitoTipMinSol || jitoTipMaxSol > HARD_CAPS.maxJitoTipSol) {
    throw new ConfigError(
      `JITO_TIP_MAX_SOL ${jitoTipMaxSol} is above the hard cap ${HARD_CAPS.maxJitoTipSol}`,
    );
  }
  if (buySizeSol != null && !(buySizeSol > 0)) {
    throw new ConfigError("BUY_SIZE_SOL must be positive");
  }
  if (buySizePctOfBalance != null && (!(buySizePctOfBalance > 0) || buySizePctOfBalance > 25)) {
    throw new ConfigError("BUY_SIZE_PCT_OF_BALANCE must be greater than 0 and at most 25");
  }
  if (mode === "paper" && buySizePctOfBalance != null && !(paperStartBalanceSol != null && paperStartBalanceSol > 0)) {
    throw new ConfigError("PAPER_START_BALANCE_SOL is required when BUY_SIZE_PCT_OF_BALANCE is set in paper mode");
  }
  if (!(liveBalanceReserveSol >= 0)) {
    throw new ConfigError("LIVE_BALANCE_RESERVE_SOL must be >= 0");
  }
  if (entryWatchMinSec < 0 || entryWatchMaxSec < 0 || entryWatchMaxSec < entryWatchMinSec) {
    throw new ConfigError("ENTRY_WATCH_MAX_SEC must be >= ENTRY_WATCH_MIN_SEC and both must be >= 0");
  }
  if (!Number.isInteger(entryMinBuys) || entryMinBuys < 1) {
    throw new ConfigError("ENTRY_MIN_BUYS must be an integer >= 1");
  }
  if (!Number.isInteger(entryMinUniqueBuyers) || entryMinUniqueBuyers < 1) {
    throw new ConfigError("ENTRY_MIN_UNIQUE_BUYERS must be an integer >= 1");
  }
  if (!(entryMinNetBuySol > 0) || !(entryMinBuyRatio > 0) || entryMinBuyRatio > 1) {
    throw new ConfigError("ENTRY_MIN_NET_BUY_SOL and ENTRY_MIN_BUY_RATIO must be positive, and the ratio at most 1");
  }
  if ((entryEarlySec == null) !== (entryEarlyMinNetBuySol == null)) {
    throw new ConfigError("ENTRY_EARLY_SEC and ENTRY_EARLY_MIN_NET_BUY_SOL must be set together");
  }
  if (entryEarlySec != null && entryEarlyMinNetBuySol != null) {
    if (!(entryEarlySec > 0) || entryEarlySec >= entryWatchMaxSec) {
      throw new ConfigError("ENTRY_EARLY_SEC must be greater than 0 and below ENTRY_WATCH_MAX_SEC");
    }
    if (!(entryEarlyMinNetBuySol > 0)) {
      throw new ConfigError("ENTRY_EARLY_MIN_NET_BUY_SOL must be positive");
    }
  }
  if (minEntryScore != null && (!(minEntryScore > 0) || minEntryScore > 100)) {
    throw new ConfigError("MIN_ENTRY_SCORE must be greater than 0 and at most 100");
  }
  if (!(entryMaxRunupPct > 0)) {
    throw new ConfigError("ENTRY_MAX_RUNUP_PCT must be positive");
  }
  if (!Number.isInteger(entryMaxWatched) || entryMaxWatched < 1) {
    throw new ConfigError("ENTRY_MAX_WATCHED must be an integer >= 1");
  }
  if (!(stopFastDropPct > 0) || stopFastDropPct > 100) {
    throw new ConfigError("STOP_FAST_DROP_PCT must be between 0 and 100");
  }
  if (earlyExitMinGainPct < 0 || earlyExitWindowSec < 0) {
    throw new ConfigError("EARLY_EXIT settings must be >= 0");
  }
  if ((postBuyGuardMs == null) !== (postBuyGuardDropPct == null)) {
    throw new ConfigError("POST_BUY_GUARD_MS and POST_BUY_GUARD_DROP_PCT must be set together");
  }
  if (postBuyGuardMs != null && postBuyGuardDropPct != null) {
    if (!(postBuyGuardMs >= 0) || !(postBuyGuardDropPct > 0)) {
      throw new ConfigError("POST_BUY_GUARD_MS must be >= 0 and POST_BUY_GUARD_DROP_PCT must be > 0");
    }
  }
  if (!(feedStallSec >= 5)) {
    throw new ConfigError(`${heliusStallExplicit ? "HELIUS_STALL_SEC" : "FEED_STALL_SEC"} must be >= 5`);
  }
  if (entryBucketSec != null && !(entryBucketSec > 0)) {
    throw new ConfigError("ENTRY_BUCKET_SEC must be positive");
  }
  if (maxDailyLossSol != null && !(maxDailyLossSol > 0)) {
    throw new ConfigError("MAX_DAILY_LOSS_SOL must be positive when set");
  }
  if (!(metadataTimeoutMs > 0)) {
    throw new ConfigError("METADATA_TIMEOUT_MS must be positive");
  }
  if (!(metadataAttemptTimeoutMs > 0)) {
    throw new ConfigError("METADATA_ATTEMPT_TIMEOUT_MS must be positive");
  }
  if (metadataRetryDeadlineSec != null && metadataRetryDeadlineSec < 0) {
    throw new ConfigError("METADATA_RETRY_DEADLINE_SEC must be >= 0");
  }
  if ((profitLockTriggerPct == null) !== (profitLockFloorPct == null)) {
    throw new ConfigError("PROFIT_LOCK_TRIGGER_PCT and PROFIT_LOCK_FLOOR_PCT must be set together");
  }
  if (profitLockTriggerPct != null && profitLockFloorPct != null) {
    if (!(profitLockTriggerPct > 0) || !(profitLockFloorPct > 0) || profitLockFloorPct >= profitLockTriggerPct) {
      throw new ConfigError("PROFIT_LOCK_FLOOR_PCT must be positive and below PROFIT_LOCK_TRIGGER_PCT");
    }
  }
  if (!(stopLossPct > 0) || stopLossPct > HARD_CAPS.maxStopLossPct) {
    throw new ConfigError(
      `STOP_LOSS_PCT ${stopLossPct} exceeds hard cap ${HARD_CAPS.maxStopLossPct}`,
    );
  }
  if (!(trailActivatePct > 0) || trailActivatePct > 500) {
    throw new ConfigError("TRAIL_ACTIVATE_PCT must be between 0 and 500");
  }
  if (!(trailDistancePct > 0) || trailDistancePct >= 100) {
    throw new ConfigError("TRAIL_DISTANCE_PCT must be between 0 and 100");
  }
  if (tp1Pct < 0 || tp1Pct > HARD_CAPS.maxTp1Pct) {
    throw new ConfigError(`TP1_PCT ${tp1Pct} exceeds hard cap ${HARD_CAPS.maxTp1Pct}`);
  }
  if (!(tp1SellFraction > 0) || tp1SellFraction > 1) {
    throw new ConfigError("TP1_SELL_FRACTION must be between 0 and 1");
  }
  if (!(priorityFeeSol >= 0) || priorityFeeSol > 0.01) {
    throw new ConfigError("PRIORITY_FEE_SOL must be between 0 and 0.01");
  }
  if (!(priorityFeeMaxLamports > 0) || priorityFeeMaxLamports > 10_000_000) {
    throw new ConfigError("PRIORITY_FEE_MAX_LAMPORTS must be between 0 and 10000000");
  }
  if (!(priorityFeeCacheMs >= 0)) {
    throw new ConfigError("PRIORITY_FEE_CACHE_MS must be >= 0");
  }
  if (!(creatorMaxHoldPct > 0) || creatorMaxHoldPct > HARD_CAPS.maxCreatorHoldPct) {
    throw new ConfigError(
      `MAX_CREATOR_HOLD_PCT ${creatorMaxHoldPct} exceeds hard cap ${HARD_CAPS.maxCreatorHoldPct}`,
    );
  }
  if (!(maxTop10Pct > 0) || maxTop10Pct > HARD_CAPS.maxTop10Pct) {
    throw new ConfigError(`MAX_TOP10_PCT ${maxTop10Pct} exceeds hard cap ${HARD_CAPS.maxTop10Pct}`);
  }
  if (!(heliusRps > 0) || heliusRps > 100) {
    throw new ConfigError("HELIUS_RPS must be between 0 and 100");
  }
  if (!(rugCheckTimeoutMs > 0)) {
    throw new ConfigError("RUG_CHECK_TIMEOUT_MS must be positive");
  }
  if (!(rpcCacheTtlMs >= 0)) {
    throw new ConfigError("RPC_CACHE_TTL_MS must be >= 0");
  }
  if (!Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > HARD_CAPS.maxOpenPositions) {
    throw new ConfigError(
      `MAX_OPEN_POSITIONS ${maxOpenPositions} exceeds hard cap ${HARD_CAPS.maxOpenPositions}`,
    );
  }
  if (!(maxHoldMinutes > 0)) {
    throw new ConfigError("MAX_HOLD_MINUTES must be positive");
  }
  if (!(liqDropPct > 0) || !(volumeStallSec > 0) || !(sellPressureRatio > 0) || !(sellPressureWindowSec > 0)) {
    throw new ConfigError("exit window settings must be positive");
  }
  if (!(volumeStallGraceSec >= 0)) {
    throw new ConfigError("VOLUME_STALL_GRACE_SEC must be >= 0");
  }
  if (!(safetyCheckTimeoutMs > 0)) {
    throw new ConfigError("SAFETY_CHECK_TIMEOUT_MS must be positive");
  }
  const slippageCeiling = Math.max(buySlippagePct, sellSlippagePct);
  if (!(paperSlippagePct >= 0) || paperSlippagePct > slippageCeiling) {
    throw new ConfigError("PAPER_SLIPPAGE_PCT must be between 0 and the buy or sell slippage cap");
  }
  if (protocolFeeBps < 0 || venueFeeBps < 0 || baseFeeSol < 0) {
    throw new ConfigError("paper fee settings must be >= 0");
  }

  if (mode === "live") {
    const key = env.PRIVATE_KEY;
    if (!key || key.trim() === "") {
      throw new ConfigError("PRIVATE_KEY is required when MODE=live");
    }
    assertLiveKey(key);
  }

  const dataDir = str(env.DATA_DIR, "./data");
  const rpcUrl = str(env.RPC_URL, "https://api.mainnet-beta.solana.com");
  const rugCheckRpcUrl = str(env.RUG_CHECK_RPC_URL, rpcUrl);
  return {
    mode,
    buySizeMinUsd,
    buySizeMaxUsd,
    maxSlippagePct: buySlippagePct,
    buySlippagePct,
    sellSlippagePct,
    stopLossPct,
    trailActivatePct,
    trailDistancePct,
    tp1Pct,
    tp1SellFraction,
    ignoredTrailTiers,
    ignoredTakeProfit,
    jitoTipSol,
    tipMode,
    jitoTipPct,
    jitoTipMinSol,
    jitoTipMaxSol,
    buySizeSol,
    buySizePctOfBalance,
    paperStartBalanceSol,
    liveBalanceReserveSol,
    entryWatchMinSec,
    entryWatchMaxSec,
    entryMinBuys,
    entryMinUniqueBuyers,
    entryMinNetBuySol,
    entryEarlySec,
    entryEarlyMinNetBuySol,
    minEntryScore,
    entryMinBuyRatio,
    entryMaxRunupPct,
    entryMaxWatched,
    entryBucketSec,
    maxDailyLossSol,
    requireSocials,
    allowNoSocialsEntry,
    noSocialsTimeStopSec,
    noSocialsMinGainPct,
    requireSocialsMode,
    metadataTimeoutMs,
    metadataRetry,
    metadataAttemptTimeoutMs,
    metadataRetryDeadlineSec,
    profitLockTriggerPct,
    profitLockFloorPct,
    stopFastDropPct,
    devSellExit,
    earlyExitMinGainPct,
    earlyExitWindowSec,
    postBuyGuardMs,
    postBuyGuardDropPct,
    priorityFeeSol,
    priorityFeeMaxLamports,
    priorityFeeCacheMs,
    creatorMaxHoldPct,
    maxTop10Pct,
    heliusRps,
    rugCheckTimeoutMs,
    rpcCacheTtlMs,
    maxOpenPositions,
    maxHoldMinutes,
    liqDropPct,
    volumeStallSec,
    volumeStallGraceSec,
    sellPressureRatio,
    sellPressureWindowSec,
    safetyCheckTimeoutMs,
    grpcUrl: grpcUrlRaw && grpcTokenPresent ? grpcUrlRaw : null,
    rpcWsUrl: str(env.RPC_WS_URL, "") || null,
    feed: env.FEED === "pumpportal" || env.FEED === "pumpdev" ? env.FEED : "helius",
    feedStallSec,
    dataWsUrl: str(env.DATA_WS_URL, "wss://pumpportal.fun/api/data"),
    wsUrl: str(env.WS_URL, "wss://pumpdev.io/ws"),
    tradeApiUrl: str(env.TRADE_API_URL, "https://pumpdev.io/api/bundle"),
    rpcUrl,
    rugCheckRpcUrl,
    jitoBlockEngineUrl: str(
      env.JITO_BLOCK_ENGINE_URL,
      "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
    ),
    solPriceUrl: str(
      env.SOL_PRICE_URL,
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    ),
    dataDir,
    tradesPath: `${dataDir}/trades.jsonl`,
    positionsPath: `${dataDir}/positions.json`,
    stopFile: str(env.STOP_FILE, "./STOP"),
    confirmTimeoutMs: num(env.CONFIRM_TIMEOUT_MS, 20_000, "CONFIRM_TIMEOUT_MS"),
    sellMaxAttempts: Math.floor(num(env.SELL_MAX_ATTEMPTS, 4, "SELL_MAX_ATTEMPTS")),
    paper: {
      slippagePct: paperSlippagePct,
      protocolFeeBps,
      venueFeeBps,
      priorityFeeSol,
      baseFeeSol,
      jitoTipSol: tipMode === "dynamic" ? jitoTipMinSol : jitoTipSol,
    },
  };
}
