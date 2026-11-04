export type ExitSignal = "tp" | "sl" | "timeout";

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

/**
 * Price exits win over the hold timer. A missing mark can still time out,
 * because the timer does not require a new trade.
 */
export function decideExit(input: {
  entryPrice: number;
  markPrice: number;
  takeProfitPct: number;
  stopLossPct: number;
  openedAtMs: number;
  nowMs: number;
  maxHoldMs: number;
}): ExitSignal | null {
  const priced = exitSignal(input.entryPrice, input.markPrice, input.takeProfitPct, input.stopLossPct);
  if (priced) return priced;
  if (input.nowMs - input.openedAtMs >= input.maxHoldMs) return "timeout";
  return null;
}
