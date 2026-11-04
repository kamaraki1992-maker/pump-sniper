import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { TrailTier } from "./risk.js";
import type { Mode } from "./types.js";

/**
 * Caps live in code on purpose. Env values outside these bounds abort startup.
 * Loosening them means editing this object.
 */
export const HARD_CAPS = {
  maxBuyUsd: 30,
  maxSlippagePct: 20,
  minJitoTipSol: 0.002,
  maxJitoTipSol: 0.005,
  maxCreatorHoldPct: 10,
  maxOpenPositions: 5,
  maxTakeProfitPct: 50,
  maxStopLossPct: 15,
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
  maxSlippagePct: number;
  takeProfitPct: number;
  stopLossPct: number;
  jitoTipSol: number;
  priorityFeeSol: number;
  creatorMaxHoldPct: number;
  maxOpenPositions: number;
  maxHoldMinutes: number;
  liqDropPct: number;
  volumeStallSec: number;
  /** No-trade time before this many seconds after entry does not count as a stall. */
  volumeStallGraceSec: number;
  /** Peak-gain tiers. Each latches a stop floor that only ratchets up. */
  trailTiers: TrailTier[];
  sellPressureRatio: number;
  sellPressureWindowSec: number;
  safetyCheckTimeoutMs: number;
  /** Set only when both GRPC_URL and GRPC_TOKEN are present. The token itself is not stored here. */
  grpcUrl: string | null;
  /** Present only when RPC_WS_URL is set. Logs must redact its api-key. */
  rpcWsUrl: string | null;
  wsUrl: string;
  tradeApiUrl: string;
  rpcUrl: string;
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

function num(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${name} must be a finite number`);
  }
  return parsed;
}

const DEFAULT_TRAIL_TIERS = "15:5,30:15,50:35,100:75";

/** "15:5,30:15,50:35,100:75" locks +5% at +15% peak, then +15%, +35%, and +75%. */
export function parseTrailTiers(value: string | undefined): TrailTier[] {
  const text = value === undefined || value.trim() === "" ? DEFAULT_TRAIL_TIERS : value.trim();
  const tiers: TrailTier[] = [];
  for (const part of text.split(",")) {
    const piece = part.trim();
    const splitAt = piece.indexOf(":");
    if (splitAt <= 0 || splitAt === piece.length - 1) {
      throw new ConfigError(`TRAIL_TIERS ${text} is invalid`);
    }
    const activatePct = Number(piece.slice(0, splitAt));
    const floorPct = Number(piece.slice(splitAt + 1));
    if (!Number.isFinite(activatePct) || !Number.isFinite(floorPct) || !(activatePct > 0)) {
      throw new ConfigError(`TRAIL_TIERS ${text} is invalid`);
    }
    tiers.push({ activatePct, floorPct });
  }
  if (tiers.length === 0) throw new ConfigError(`TRAIL_TIERS ${text} is invalid`);
  tiers.sort((a, b) => a.activatePct - b.activatePct);
  for (let i = 1; i < tiers.length; i += 1) {
    const prev = tiers[i - 1];
    const next = tiers[i];
    if (!prev || !next || next.floorPct < prev.floorPct) {
      throw new ConfigError(`TRAIL_TIERS ${text} floors must rise with the peak`);
    }
  }
  return tiers;
}

export function formatTrailTiers(tiers: readonly TrailTier[]): string {
  return tiers.map((tier) => `${tier.activatePct}:${tier.floorPct}`).join(",");
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

export function requiredBuyBalanceSol(config: AppConfig, buySize: number, openPositions = 0): number {
  const txFee = config.priorityFeeSol + config.paper.baseFeeSol;
  const exitReserve = txFee + config.jitoTipSol;
  return buySize + txFee + config.jitoTipSol + exitReserve + openPositions * exitReserve;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode: Mode = env.MODE === "live" ? "live" : "paper";
  const buySizeMinUsd = num(env.BUY_SIZE_MIN_USD, 5, "BUY_SIZE_MIN_USD");
  const buySizeMaxUsd = num(env.BUY_SIZE_MAX_USD, HARD_CAPS.maxBuyUsd, "BUY_SIZE_MAX_USD");
  const maxSlippagePct = num(env.MAX_SLIPPAGE_PCT, 3, "MAX_SLIPPAGE_PCT");
  const jitoTipSol = num(env.JITO_TIP_SOL, 0.002, "JITO_TIP_SOL");
  const takeProfitPct = num(env.TAKE_PROFIT_PCT, 0, "TAKE_PROFIT_PCT");
  const stopLossPct = num(env.STOP_LOSS_PCT, HARD_CAPS.maxStopLossPct, "STOP_LOSS_PCT");
  const priorityFeeSol = num(env.PRIORITY_FEE_SOL, 0.00005, "PRIORITY_FEE_SOL");
  const creatorMaxHoldPct = num(env.CREATOR_MAX_HOLD_PCT, 10, "CREATOR_MAX_HOLD_PCT");
  const maxOpenPositions = num(env.MAX_OPEN_POSITIONS, HARD_CAPS.maxOpenPositions, "MAX_OPEN_POSITIONS");
  const maxHoldMinutes = num(env.MAX_HOLD_MINUTES, 10, "MAX_HOLD_MINUTES");
  const liqDropPct = num(env.LIQ_DROP_PCT, 20, "LIQ_DROP_PCT");
  const volumeStallSec = num(env.VOLUME_STALL_SEC, 45, "VOLUME_STALL_SEC");
  const volumeStallGraceSec = num(env.VOLUME_STALL_GRACE_SEC, 90, "VOLUME_STALL_GRACE_SEC");
  const trailTiers = parseTrailTiers(env.TRAIL_TIERS);
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
  if (!(maxSlippagePct > 0) || maxSlippagePct > HARD_CAPS.maxSlippagePct) {
    throw new ConfigError(
      `MAX_SLIPPAGE_PCT ${maxSlippagePct} exceeds hard cap ${HARD_CAPS.maxSlippagePct}`,
    );
  }
  if (jitoTipSol < HARD_CAPS.minJitoTipSol || jitoTipSol > HARD_CAPS.maxJitoTipSol) {
    throw new ConfigError(
      `JITO_TIP_SOL ${jitoTipSol} is outside hard bounds ${HARD_CAPS.minJitoTipSol}-${HARD_CAPS.maxJitoTipSol}`,
    );
  }
  if (takeProfitPct < 0 || takeProfitPct > HARD_CAPS.maxTakeProfitPct) {
    throw new ConfigError(
      `TAKE_PROFIT_PCT ${takeProfitPct} exceeds hard cap ${HARD_CAPS.maxTakeProfitPct}`,
    );
  }
  if (!(stopLossPct > 0) || stopLossPct > HARD_CAPS.maxStopLossPct) {
    throw new ConfigError(
      `STOP_LOSS_PCT ${stopLossPct} exceeds hard cap ${HARD_CAPS.maxStopLossPct}`,
    );
  }
  if (!(priorityFeeSol >= 0) || priorityFeeSol > 0.01) {
    throw new ConfigError("PRIORITY_FEE_SOL must be between 0 and 0.01");
  }
  if (!(creatorMaxHoldPct > 0) || creatorMaxHoldPct > HARD_CAPS.maxCreatorHoldPct) {
    throw new ConfigError(
      `CREATOR_MAX_HOLD_PCT ${creatorMaxHoldPct} exceeds hard cap ${HARD_CAPS.maxCreatorHoldPct}`,
    );
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
  if (!(paperSlippagePct >= 0) || paperSlippagePct > maxSlippagePct) {
    throw new ConfigError("PAPER_SLIPPAGE_PCT must be between 0 and MAX_SLIPPAGE_PCT");
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
  return {
    mode,
    buySizeMinUsd,
    buySizeMaxUsd,
    maxSlippagePct,
    takeProfitPct,
    stopLossPct,
    jitoTipSol,
    priorityFeeSol,
    creatorMaxHoldPct,
    maxOpenPositions,
    maxHoldMinutes,
    liqDropPct,
    volumeStallSec,
    volumeStallGraceSec,
    trailTiers,
    sellPressureRatio,
    sellPressureWindowSec,
    safetyCheckTimeoutMs,
    grpcUrl: grpcUrlRaw && grpcTokenPresent ? grpcUrlRaw : null,
    rpcWsUrl: str(env.RPC_WS_URL, "") || null,
    wsUrl: str(env.WS_URL, "wss://pumpdev.io/ws"),
    tradeApiUrl: str(env.TRADE_API_URL, "https://pumpdev.io/api/bundle"),
    rpcUrl: str(env.RPC_URL, "https://api.mainnet-beta.solana.com"),
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
      jitoTipSol,
    },
  };
}
