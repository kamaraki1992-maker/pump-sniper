export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 0-1 score from the creator's launch allocation (lower is better), the
 * buy/sell counts seen so far, and whether the safety check passed.
 * Weights: hold 0.4, flow 0.3, safety 0.3. No flow yet is neutral (0.5).
 */
export function confidenceScore(input: {
  holdPct: number;
  buys: number;
  sells: number;
  safetyOk: boolean;
}): number {
  const hold = 1 - Math.min(Math.max(input.holdPct, 0), 10) / 10;
  const prints = input.buys + input.sells;
  const flow = prints === 0 ? 0.5 : input.buys / prints;
  const safety = input.safetyOk ? 1 : 0;
  return clamp01(0.4 * hold + 0.3 * flow + 0.3 * safety);
}

/** Linear map from confidence onto [minUsd, maxUsd]. */
export function sizeFromConfidence(score: number, minUsd: number, maxUsd: number): number {
  const span = Math.max(0, maxUsd - minUsd);
  return minUsd + clamp01(score) * span;
}
