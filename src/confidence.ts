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
  /** Hold and safety set the base. Net buy flow scales it toward 1. */
  raw: number;
  /** `raw` squared. This is what maps onto the USD size range. */
  score: number;
}

/**
 * No-flow weight. Squared, a clean safety-pass with no creator hold maps to
 * a score of 0.28, which is $12 on the $5..$30 line. Net buy flow fills the
 * rest of the way to 1.
 */
const NO_FLOW_WEIGHT = Math.sqrt(0.28);

/**
 * Hold and safety set a base near the middle of the size range. Net buy flow
 * scales that base up to 1. Without safety the score is 0. Without net buying
 * the raw value stays at or below `NO_FLOW_WEIGHT`.
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
  const netFlow = buys > sells && buys > 0 ? flow : 0;
  let raw = safety * hold * (NO_FLOW_WEIGHT + (1 - NO_FLOW_WEIGHT) * netFlow);
  if (!(input.safetyOk && netFlow > 0)) raw = Math.min(raw, NO_FLOW_WEIGHT);
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
