export type ExitSignal = "tp" | "sl" | "timeout" | "liquidity_drop" | "volume_stall" | "sell_pressure";

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
  entryVSolSol?: number | null;
  lastVSolSol?: number | null;
  liqDropPct?: number;
  lastTradeAtMs?: number;
  volumeStallMs?: number;
  sellsInWindow?: number;
  buysInWindow?: number;
  sellPressureRatio?: number;
  minPressureSells?: number;
  /** When false, curve SOL from the trade stream is ignored. An account subscription owns that exit. */
  useStreamLiquidity?: boolean;
}): ExitSignal | null {
  const priced = exitSignal(input.entryPrice, input.markPrice, input.takeProfitPct, input.stopLossPct);
  if (priced) return priced;
  const liqDropPct = input.liqDropPct ?? 20;
  if (input.useStreamLiquidity !== false && reservesDropped(input.entryVSolSol, input.lastVSolSol, liqDropPct)) {
    return "liquidity_drop";
  }
  const sells = input.sellsInWindow ?? 0;
  const buys = input.buysInWindow ?? 0;
  const ratio = input.sellPressureRatio ?? 3;
  const minSells = input.minPressureSells ?? 4;
  if (sells >= minSells && sells >= ratio * buys) return "sell_pressure";
  const lastTradeAtMs = input.lastTradeAtMs ?? input.nowMs;
  const volumeStallMs = input.volumeStallMs ?? Number.POSITIVE_INFINITY;
  if (input.nowMs - lastTradeAtMs >= volumeStallMs) return "volume_stall";
  if (input.nowMs - input.openedAtMs >= input.maxHoldMs) return "timeout";
  return null;
}

/** True when current reserves are more than `dropPct` percent below entry. */
export function reservesDropped(
  entry: number | null | undefined,
  current: number | null | undefined,
  dropPct: number,
): boolean {
  if (entry == null || current == null || !(entry > 0) || !Number.isFinite(current)) return false;
  return ((entry - current) / entry) * 100 > dropPct;
}
