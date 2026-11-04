import { TOTAL_SUPPLY_TOKENS } from "./pricing.js";

/** Initial bonding-curve FDV is about 27.96 SOL. Near that, after the creator left, the token round-tripped to the floor. */
export const CURVE_FLOOR_SOL = 27.96;
export const RUG_FLOOR_MAX_SOL = 32;
export const LAUNCH_WINDOW_SEC = 120;
export const DUMP_WINDOW_SEC = 15 * 60;
export const RUG_MIN_AGE_SEC = 30 * 60;
/** Remaining at or under this fraction of the launch-window peak means most of the allocation was sold. */
export const DUMP_REMAINING_FRACTION = 0.5;

export interface FilterDecision {
  ok: boolean;
  reason?: string;
}

export function holdDecision(initialBuyTokens: number, maxPct: number): FilterDecision {
  if (!Number.isFinite(initialBuyTokens) || initialBuyTokens < 0) {
    return { ok: false, reason: "creator-hold-unknown" };
  }
  const pct = (initialBuyTokens / TOTAL_SUPPLY_TOKENS) * 100;
  if (pct >= maxPct) {
    return {
      ok: false,
      reason: `creator holds ${pct.toFixed(2)}% of supply (>= ${maxPct}%)`,
    };
  }
  return { ok: true };
}

export interface HistoryTx {
  blockTimeSec: number;
  logs: string[];
  /** Mint created in this transaction, when the logs say Create / CreateV2. */
  createdMint: string | null;
  /** Creator-owned balances only, in display tokens. */
  balances: { mint: string; preUi: number; postUi: number }[];
}

export interface CurveMark {
  mint: string;
  marketCapSol: number;
}

const CREATE_LOG = /Instruction: Create(?:V2)?\b/;

export function isCreateLog(line: string): boolean {
  return CREATE_LOG.test(line);
}

function creatorPost(tx: HistoryTx, mint: string): number | null {
  let seen = false;
  let post = 0;
  for (const row of tx.balances) {
    if (row.mint !== mint) continue;
    seen = true;
    post = row.postUi;
  }
  return seen ? post : null;
}

interface LaunchWindow {
  mint: string;
  time: number;
  peak: number;
  peakTime: number;
}

function launchWindows(txs: HistoryTx[]): LaunchWindow[] {
  const launches: LaunchWindow[] = [];
  for (const tx of txs) {
    if (!tx.createdMint && !tx.logs.some(isCreateLog)) continue;
    const mint = tx.createdMint;
    if (!mint) continue;
    let peak = 0;
    let peakTime = tx.blockTimeSec;
    for (const other of txs) {
      if (other.blockTimeSec < tx.blockTimeSec) continue;
      if (other.blockTimeSec > tx.blockTimeSec + LAUNCH_WINDOW_SEC) continue;
      const post = creatorPost(other, mint);
      if (post !== null && post >= peak) {
        peak = post;
        peakTime = other.blockTimeSec;
      }
    }
    launches.push({ mint, time: tx.blockTimeSec, peak, peakTime });
  }
  return launches;
}

/**
 * Prior launches only. A dev dump is a sale of at least half the tokens the
 * creator accumulated in the first two minutes, inside fifteen minutes of
 * the create. A rug is an older launch that is back at the curve floor after
 * the creator's balance fell to ~0.
 */
export function historyDecision(
  txs: HistoryTx[],
  curves: CurveMark[],
  nowSec: number,
): FilterDecision {
  const launches = launchWindows(txs);
  for (const launch of launches) {
    if (!(launch.peak > 0)) continue;
    for (const tx of txs) {
      if (tx.blockTimeSec < launch.peakTime) continue;
      if (tx.blockTimeSec > launch.time + DUMP_WINDOW_SEC) continue;
      const post = creatorPost(tx, launch.mint);
      if (post === null) continue;
      if (post < launch.peak * DUMP_REMAINING_FRACTION) {
        return {
          ok: false,
          reason: `creator-dev-dump mint=${launch.mint} remaining=${post} peak=${launch.peak}`,
        };
      }
    }
  }

  for (const launch of launches) {
    if (!(launch.peak > 0)) continue;
    if (nowSec - launch.time < RUG_MIN_AGE_SEC) continue;
    const curve = curves.find((item) => item.mint === launch.mint);
    if (!curve || curve.marketCapSol > RUG_FLOOR_MAX_SOL) continue;
    let latest: number | null = null;
    let latestTime = -1;
    for (const tx of txs) {
      const post = creatorPost(tx, launch.mint);
      if (post === null) continue;
      if (tx.blockTimeSec >= latestTime) {
        latestTime = tx.blockTimeSec;
        latest = post;
      }
    }
    if (latest !== null && latest <= launch.peak * 0.1) {
      return {
        ok: false,
        reason: `creator-rug mint=${launch.mint} marketCapSol=${curve.marketCapSol}`,
      };
    }
  }

  return { ok: true };
}

/** Virtual reserves sit at offsets 8 and 16 on current pump bonding-curve accounts. */
export function marketCapSolFromCurveData(data: Uint8Array): number | null {
  if (data.byteLength < 24) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const vTokensRaw = Number(view.getBigUint64(8, true));
  const vSolLamports = Number(view.getBigUint64(16, true));
  if (!(vTokensRaw > 0) || !(vSolLamports > 0)) return null;
  const tokens = vTokensRaw / 1e6;
  const sol = vSolLamports / 1e9;
  return (sol / tokens) * TOTAL_SUPPLY_TOKENS;
}
