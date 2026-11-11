import { constantProductBuy, constantProductSell } from "../momentum/paper.js";
import type { TradeReason } from "../types.js";

/**
 * Scalp rules. The spike itself comes from the trade stream. DexScreener and
 * the RPC reads are only the gate after a spike, and a slow gate is a skip.
 *
 * The 60-second rise is (current price - lowest price in that window) / low.
 * Ten consecutive buys means the latest ten prints are buys. A sell anywhere
 * in those ten rejects the spike. A rise above the configured max is anti-FOMO.
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
  gateMs: 3_000,
  /** Start the safety reads once the 60-second rise reaches this. */
  warmRise: 0.06,
  /** Keep the ATA this long in case the same mint is bought again. */
  ataReuseMs: 10 * 60 * 1000,
} as const;

export interface ScalpPrint {
  atMs: number;
  priceSol: number;
  side: "buy" | "sell";
  solAmount?: number | null;
}

export interface ScalpLargeBuy {
  sol: number;
  usd: number | null;
  /** Which bar this buy cleared. `both` means it cleared the USD floor and the SOL floor. */
  via: "usd" | "sol" | "both";
}

export interface ScalpSpike {
  ok: boolean;
  reason: string;
  risePct: number | null;
  buys: number;
}

/** Rise from the lowest print in the trailing 60 seconds, plus the buy streak. */
export function scalpSpike(
  prints: readonly ScalpPrint[],
  nowMs: number,
  band: { minPct: number; maxPct: number } = { minPct: SCALP.minRise * 100, maxPct: SCALP.maxRise * 100 },
): ScalpSpike {
  const window = prints.filter((print) => print.atMs >= nowMs - SCALP.windowMs && print.atMs <= nowMs && print.priceSol > 0);
  if (window.length < 2) return { ok: false, reason: "spike_history", risePct: null, buys: streak(prints) };
  let low = window[0]!.priceSol;
  for (const print of window) if (print.priceSol < low) low = print.priceSol;
  const current = window[window.length - 1]!.priceSol;
  const rise = low > 0 ? (current - low) / low : 0;
  const minRise = band.minPct / 100;
  const maxRise = band.maxPct / 100;
  const buys = streak(prints);
  if (rise > maxRise + 1e-9) return { ok: false, reason: "fomo", risePct: rise * 100, buys };
  if (rise + 1e-9 < minRise) return { ok: false, reason: "spike", risePct: rise * 100, buys };
  if (buys < SCALP.consecutiveBuys) return { ok: false, reason: "consecutive_buys", risePct: rise * 100, buys };
  return { ok: true, reason: "spike", risePct: rise * 100, buys };
}

/**
 * Buys in the window that are at least `minUsd` at the live SOL price, or
 * at least `minSol`. Either bar is enough, so the lower one is the one
 * that actually qualifies the print.
 */
export function scalpLargeBuys(
  prints: readonly ScalpPrint[],
  nowMs: number,
  input: { windowMs: number; minUsd: number; minSol: number; minCount: number; solUsd: number | null },
): { ok: boolean; buys: ScalpLargeBuy[] } {
  const solUsd = input.solUsd != null && input.solUsd > 0 ? input.solUsd : null;
  const buys: ScalpLargeBuy[] = [];
  for (const print of prints) {
    if (print.side !== "buy" || print.atMs < nowMs - input.windowMs || print.atMs > nowMs) continue;
    const sol = print.solAmount ?? 0;
    if (!(sol > 0)) continue;
    const usd = solUsd != null ? sol * solUsd : null;
    const byUsd = usd != null && usd >= input.minUsd;
    const bySol = sol >= input.minSol;
    if (!byUsd && !bySol) continue;
    buys.push({ sol, usd, via: byUsd && bySol ? "both" : byUsd ? "usd" : "sol" });
  }
  return { ok: buys.length >= input.minCount, buys };
}

/**
 * True once the tape is worth warming: the 60-second rise is at least 6%,
 * or one buy has already cleared a large-buy bar.
 */
export function scalpWarmInterest(
  prints: readonly ScalpPrint[],
  nowMs: number,
  large: { windowMs: number; minUsd: number; minSol: number; solUsd: number | null },
): boolean {
  const window = prints.filter((print) => print.atMs >= nowMs - SCALP.windowMs && print.atMs <= nowMs && print.priceSol > 0);
  if (window.length >= 2) {
    let low = window[0]!.priceSol;
    for (const print of window) if (print.priceSol < low) low = print.priceSol;
    const current = window[window.length - 1]!.priceSol;
    const rise = low > 0 ? (current - low) / low : 0;
    if (rise + 1e-9 >= SCALP.warmRise) return true;
  }
  return scalpLargeBuys(prints, nowMs, { ...large, minCount: 1 }).ok;
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

/**
 * Priority fee is whatever is left of the 0.0002 budget after the Jito tip,
 * so the two together are one 0.0002 SOL charge per transaction.
 */
export function scalpExecutionFee(totalSol: number, tipSol: number): { priorityFeeSol: number; tipSol: number } {
  const total = Math.max(0, totalSol);
  const tip = Math.min(total, Math.max(0, tipSol));
  return { priorityFeeSol: total - tip, tipSol: tip };
}

export interface RoundTripEstimate {
  costSol: number;
  costPct: number;
  poolFeeSol: number;
  impactSol: number;
  closeFeeSol: number;
  txFeeSol: number;
}

/**
 * Round trip in SOL: both base fees, both combined priority+tip charges,
 * pool fees and impact both ways, and the close-account fee. The ATA rent
 * itself comes back, so it is not part of the cost.
 */
export function scalpRoundTripCost(input: {
  sizeSol: number;
  reserves: { baseTokens: number; quoteSol: number } | null;
  feeBps: number;
  baseFeeSol: number;
  txFeeSol: number;
}): RoundTripEstimate | null {
  const { sizeSol, reserves, feeBps, baseFeeSol, txFeeSol } = input;
  if (!(sizeSol > 0) || !reserves || !(reserves.baseTokens > 0) || !(reserves.quoteSol > 0)) return null;
  const buy = constantProductBuy(reserves, sizeSol, feeBps);
  if (!buy) return null;
  const sell = constantProductSell(reserves, buy.tokensOut, feeBps);
  if (!sell) return null;
  const spotValue = buy.tokensOut * buy.spotPriceSol;
  const buyGap = Math.max(0, sizeSol - spotValue);
  const sellGap = Math.max(0, spotValue - sell.solOut);
  const closeFeeSol = baseFeeSol;
  const bothWaysTx = txFeeSol * 2;
  const costSol = baseFeeSol * 2 + bothWaysTx + buyGap + sellGap + closeFeeSol;
  return {
    costSol,
    costPct: costSol / sizeSol,
    poolFeeSol: buy.swapFeeSol + sell.swapFeeSol,
    impactSol: Math.max(0, buyGap - buy.swapFeeSol) + Math.max(0, sellGap - sell.swapFeeSol),
    closeFeeSol,
    txFeeSol: bothWaysTx,
  };
}

export function scalpRemainderNetSol(input: {
  tokenAmount: number;
  priceSol: number;
  feeBps: number;
  baseFeeSol: number;
  txFeeSol: number;
}): number {
  const tokens = input.tokenAmount * (1 - SCALP.tpOfOriginal);
  if (!(tokens > 0) || !(input.priceSol > 0)) return 0;
  const gross = tokens * input.priceSol * (1 - input.feeBps / 10_000);
  return gross - input.baseFeeSol - input.txFeeSol - input.baseFeeSol;
}

/** Initial stop stays a raw -12%. After the net +12% peak, the floor is a net +3%. */
export function scalpStopPrice(entryPriceSol: number, peakPriceSol: number, costPct = 0): number {
  const peak = Math.max(peakPriceSol, entryPriceSol);
  const gain = entryPriceSol > 0 ? (peak - entryPriceSol) / entryPriceSol : 0;
  if (gain + 1e-9 >= SCALP.lockGain + costPct) return entryPriceSol * (1 + SCALP.lockStop + costPct);
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
  /** Round-trip cost as a fraction of size. Targets are net of this. */
  costPct?: number;
  /** When the unsold 40% is worth less than the minimum, the partial becomes a full sell. */
  sellAll?: boolean;
}): ScalpExit | null {
  const entry = input.entryPriceSol;
  const price = input.priceSol;
  const cost = input.costPct ?? 0;
  if (!(entry > 0) || !(price > 0)) return null;
  const peak = Math.max(input.peakPriceSol, price);
  if (price <= scalpStopPrice(entry, peak, cost)) return { reason: "scalp_sl", sellFraction: 1 };
  if (!input.tpTaken && price >= entry * (1 + SCALP.tpGain + cost)) {
    return { reason: "scalp_tp", sellFraction: input.sellAll ? 1 : SCALP.tpOfOriginal };
  }
  if (input.tpTaken && price <= peak * (1 - SCALP.trailDrop)) return { reason: "scalp_trail", sellFraction: 1 };
  const peakGain = (peak - entry) / entry;
  if (input.nowMs - input.openedAtMs >= SCALP.fastHoldMs && peakGain + 1e-9 < SCALP.fastMinGain + cost) {
    return { reason: "scalp_fast", sellFraction: 1 };
  }
  if (input.nowMs - input.openedAtMs >= input.maxHoldMs) return { reason: "scalp_max_hold", sellFraction: 1 };
  return null;
}
