export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export interface ConfidenceBreakdown {
  /** 1 when the creator holds nothing, 0 at the 10% hold cap. */
  hold: number;
  /** Share of prints that are buys. 0 when there are no buys. */
  flow: number;
  /** 1 when the safety check passed, otherwise 0. */
  safety: number;
  /** Product of the three signals, capped at 0.5 unless flow is net buying and safety passed. */
  raw: number;
  /** `raw` squared. This is what maps onto the USD size range. */
  score: number;
}

/**
 * Conservative 0-1 score. Signals are multiplied, so any missing one pulls
 * the result toward 0. The product cannot exceed 0.5 unless early flow is
 * net buying and the safety check passed. Squaring then keeps ordinary
 * tokens near the floor of the size range.
 */
export function confidenceBreakdown(input: {
  holdPct: number;
  buys: number;
  sells: number;
  safetyOk: boolean;
}): ConfidenceBreakdown {
  const hold = clamp01(1 - Math.min(Math.max(input.holdPct, 0), 10) / 10);
  const buys = Number.isFinite(input.buys) ? Math.max(0, input.buys) : 0;
  const sells = Number.isFinite(input.sells) ? Math.max(0, input.sells) : 0;
  const prints = buys + sells;
  const flow = buys > 0 && prints > 0 ? clamp01(buys / prints) : 0;
  const safety = input.safetyOk ? 1 : 0;
  let raw = hold * flow * safety;
  const strong = buys > sells && buys > 0 && input.safetyOk;
  if (!strong) raw = Math.min(raw, 0.5);
  return { hold, flow, safety, raw, score: clamp01(raw * raw) };
}

export function confidenceScore(input: {
  holdPct: number;
  buys: number;
  sells: number;
  safetyOk: boolean;
}): number {
  return confidenceBreakdown(input).score;
}

/** Linear map from an already-curved confidence score onto [minUsd, maxUsd]. */
export function sizeFromConfidence(score: number, minUsd: number, maxUsd: number): number {
  const span = Math.max(0, maxUsd - minUsd);
  return minUsd + clamp01(score) * span;
}
