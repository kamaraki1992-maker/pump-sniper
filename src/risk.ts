export type ExitSignal = "tp" | "sl";

/** Fraction of the position closed by a take-profit or stop-loss. v1 always closes 100%. */
export const FULL_EXIT_FRACTION = 1;

/**
 * `takeProfitPct` of 50 means the mark is at least 1.5x the entry fill.
 * `stopLossPct` of 15 means the mark is at most 85% of the entry fill.
 */
export function exitSignal(
  entryPrice: number,
  markPrice: number,
  takeProfitPct: number,
  stopLossPct: number,
): ExitSignal | null {
  if (!(entryPrice > 0) || !(markPrice > 0)) return null;
  const ratio = markPrice / entryPrice;
  if (ratio >= 1 + takeProfitPct / 100) return "tp";
  if (ratio <= 1 - stopLossPct / 100) return "sl";
  return null;
}
