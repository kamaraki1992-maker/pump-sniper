import type { TradeReason } from "../types.js";

/**
 * Scalp rules. The spike itself comes from the trade stream. DexScreener and
 * the RPC reads are only the gate after a spike, and a slow gate is a skip.
 *
 * The 60-second rise is (current price - lowest price in that window) / low.
 * Ten consecutive buys means the latest ten prints are buys. A sell anywhere
 * in those ten rejects the spike. A rise above 25% is anti-FOMO, not an entry.
 */
export const SCALP = {
  minAgeMs: 60 * 1000,
  maxAgeMs: 6 * 60 * 60 * 1000,
  minLiquidityUsd: 10_000,
  windowMs: 60 * 1000,
  minRise: 0.12,
  maxRise: 0.25,
  consecutiveBuys: 10,
  stopDrop: 0.12,
  lockGain: 0.12,
  lockStop: 0.03,
  tpGain: 0.18,
  tpOfOriginal: 0.6,
  trailDrop: 0.1,
  fastHoldMs: 5 * 60 * 1000,
  fastMinGain: 0.1,
  gateMs: 1_500,
} as const;

export interface ScalpPrint {
  atMs: number;
  priceSol: number;
  side: "buy" | "sell";
}

export interface ScalpSpike {
  ok: boolean;
  reason: string;
  risePct: number | null;
  buys: number;
}

/** Rise from the lowest print in the trailing 60 seconds, plus the buy streak. */
export function scalpSpike(prints: readonly ScalpPrint[], nowMs: number): ScalpSpike {
  const window = prints.filter((print) => print.atMs >= nowMs - SCALP.windowMs && print.atMs <= nowMs && print.priceSol > 0);
  if (window.length < 2) return { ok: false, reason: "spike_history", risePct: null, buys: streak(prints) };
  let low = window[0]!.priceSol;
  for (const print of window) if (print.priceSol < low) low = print.priceSol;
  const current = window[window.length - 1]!.priceSol;
  const rise = low > 0 ? (current - low) / low : 0;
  const buys = streak(prints);
  if (rise > SCALP.maxRise) return { ok: false, reason: "fomo", risePct: rise * 100, buys };
  if (rise < SCALP.minRise) return { ok: false, reason: "spike", risePct: rise * 100, buys };
  if (buys < SCALP.consecutiveBuys) return { ok: false, reason: "consecutive_buys", risePct: rise * 100, buys };
  return { ok: true, reason: "spike", risePct: rise * 100, buys };
}

/** Buys at the end of the tape. A sell resets the count. */
export function streak(prints: readonly ScalpPrint[]): number {
  let count = 0;
  for (let i = prints.length - 1; i >= 0; i -= 1) {
    if (prints[i]!.side !== "buy") break;
    count += 1;
  }
  return count;
}

export interface ScalpGateFacts {
  ageMs: number | null;
  liquidityUsd: number | null;
  mintOk: boolean;
  mintReason: string | null;
  honeypotOk: boolean;
  honeypotReason: string | null;
  top10Pct: number | null;
  devPct: number | null;
  bundlePct: number | null;
  socialsOk: boolean;
}

/** Safety and universe checks. A missing figure fails closed. */
export function scalpGate(facts: ScalpGateFacts): { ok: boolean; reason: string } {
  if (facts.ageMs == null) return { ok: false, reason: "age_unknown" };
  if (facts.ageMs < SCALP.minAgeMs) return { ok: false, reason: "too_young" };
  if (facts.ageMs >= SCALP.maxAgeMs) return { ok: false, reason: "too_old" };
  if (facts.liquidityUsd == null || !(facts.liquidityUsd >= SCALP.minLiquidityUsd)) return { ok: false, reason: "liquidity" };
  if (!facts.mintOk) return { ok: false, reason: facts.mintReason ?? "mint_authority" };
  if (!facts.honeypotOk) return { ok: false, reason: facts.honeypotReason ?? "honeypot" };
  if (facts.top10Pct == null || !(facts.top10Pct < 25)) return { ok: false, reason: facts.top10Pct == null ? "top10_unavailable" : "top10" };
  if (facts.devPct == null || !(facts.devPct < 4)) return { ok: false, reason: facts.devPct == null ? "dev_unknown" : "dev_wallet" };
  if (facts.bundlePct == null || !(facts.bundlePct < 15)) return { ok: false, reason: facts.bundlePct == null ? "bundle_unknown" : "bundle" };
  if (!facts.socialsOk) return { ok: false, reason: "no_socials" };
  return { ok: true, reason: "scalp" };
}

export function scalpStopPrice(entryPriceSol: number, peakPriceSol: number): number {
  const peak = Math.max(peakPriceSol, entryPriceSol);
  const gain = entryPriceSol > 0 ? (peak - entryPriceSol) / entryPriceSol : 0;
  if (gain + 1e-9 >= SCALP.lockGain) return entryPriceSol * (1 + SCALP.lockStop);
  return entryPriceSol * (1 - SCALP.stopDrop);
}

export interface ScalpExit {
  reason: TradeReason;
  /** Share of the tokens still held. */
  sellFraction: number;
}

/**
 * One exit per call. Stop first, then the 60% take-profit, then the 10%
 * trail on what remains, then the 5-minute rule, then the hard max hold.
 */
export function scalpExit(input: {
  entryPriceSol: number;
  peakPriceSol: number;
  priceSol: number;
  tpTaken: boolean;
  openedAtMs: number;
  nowMs: number;
  maxHoldMs: number;
}): ScalpExit | null {
  const entry = input.entryPriceSol;
  const price = input.priceSol;
  if (!(entry > 0) || !(price > 0)) return null;
  const peak = Math.max(input.peakPriceSol, price);
  if (price <= scalpStopPrice(entry, peak)) return { reason: "scalp_sl", sellFraction: 1 };
  if (!input.tpTaken && price >= entry * (1 + SCALP.tpGain)) return { reason: "scalp_tp", sellFraction: SCALP.tpOfOriginal };
  if (input.tpTaken && price <= peak * (1 - SCALP.trailDrop)) return { reason: "scalp_trail", sellFraction: 1 };
  const peakGain = (peak - entry) / entry;
  if (input.nowMs - input.openedAtMs >= SCALP.fastHoldMs && peakGain + 1e-9 < SCALP.fastMinGain) {
    return { reason: "scalp_fast", sellFraction: 1 };
  }
  if (input.nowMs - input.openedAtMs >= input.maxHoldMs) return { reason: "scalp_max_hold", sellFraction: 1 };
  return null;
}
