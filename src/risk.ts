export type ExitSignal =
  | "tp"
  | "sl"
  | "timeout"
  | "liquidity_drop"
  | "volume_stall"
  | "sell_pressure"
  | "trailing_stop"
  | "dev_sell"
  | "fast_drop"
  | "early_no_momentum"
  | "profit_lock";

export interface ExitPlan {
  signal: ExitSignal;
  /** Share of the remaining position to sell. Stop, trail, and timer exits are 1. */
  fraction: number;
}

/** Full close used by the stop, the trail, and the timer. The 2x take profit is partial. */
export const FULL_EXIT_FRACTION = 1;

/** Hard stop price. `stopLossPct` of 20 is 80% of the entry fill. */
export function stopLossPrice(entry: number, stopLossPct: number): number | null {
  if (!(entry > 0) || !(stopLossPct > 0)) return null;
  return entry * (1 - stopLossPct / 100);
}

/**
 * Once `peak` reaches `activatePct`, the stop is `max(entry, peak * (1 - distance))`.
 * Entry is break-even. The distance trail is tighter whenever it sits above entry.
 * Returns null until the peak has armed the trail.
 */
export function trailStopPrice(
  entry: number,
  peak: number,
  activatePct: number,
  distancePct: number,
): number | null {
  if (!(entry > 0) || !(peak > 0) || !(activatePct > 0)) return null;
  if (!(distancePct >= 0) || distancePct >= 100) return null;
  if (peak + 1e-9 < entry * (1 + activatePct / 100)) return null;
  return Math.max(entry, peak * (1 - distancePct / 100));
}

/**
 * Once the peak reaches `triggerPct`, the floor is `entry * (1 + floorPct/100)`.
 * It does not move with later peaks. Null until the trigger is reached.
 */
export function profitLockPrice(
  entry: number,
  peak: number,
  triggerPct: number | null | undefined,
  floorPct: number | null | undefined,
): number | null {
  if (triggerPct == null || floorPct == null) return null;
  if (!(entry > 0) || !(peak > 0) || !(triggerPct > 0)) return null;
  const gain = ((peak / entry) - 1) * 100;
  if (gain + 1e-9 < triggerPct) return null;
  return entry * (1 + floorPct / 100);
}

/** A later dip cannot loosen a stop that already latched. */
export function ratchetStop(current: number | null | undefined, next: number | null): number | null {
  if (next == null || !(next > 0) || !Number.isFinite(next)) return current ?? null;
  if (current == null || !(current > 0) || !Number.isFinite(current)) return next;
  return Math.max(current, next);
}

/**
 * Price exits win over the hold timer. A missing mark can still time out,
 * because the timer does not require a new trade. The partial take profit
 * fires on the same mark that crosses `tp1Pct` and does not repeat.
 */
export function decideExit(input: {
  entryPrice: number;
  markPrice: number;
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
  /** Silence before this many ms after entry does not count toward a volume stall. */
  volumeStallGraceMs?: number;
  /** Latched trail stop in SOL per token. Null until +activate has been seen. */
  trailStopPriceSol?: number | null;
  /** Latched profit-lock floor. Null until the trigger gain has been seen. */
  profitLockPriceSol?: number | null;
  tp1Pct?: number;
  tp1SellFraction?: number;
  tp1Taken?: boolean;
}): ExitPlan | null {
  const entry = input.entryPrice;
  const mark = input.markPrice;
  if (entry > 0 && mark > 0) {
    const trail = input.trailStopPriceSol != null && input.trailStopPriceSol > 0 ? input.trailStopPriceSol : null;
    const locked = input.profitLockPriceSol != null && input.profitLockPriceSol > 0 ? input.profitLockPriceSol : null;
    const floor = trail != null && locked != null ? Math.max(trail, locked) : (trail ?? locked);
    if (floor != null && mark <= floor) {
      const signal = trail != null && trail >= (locked ?? 0) ? "trailing_stop" : "profit_lock";
      return { signal, fraction: FULL_EXIT_FRACTION };
    }
    const sl = stopLossPrice(entry, input.stopLossPct);
    if (sl != null && mark <= sl) return { signal: "sl", fraction: FULL_EXIT_FRACTION };
    const tp1Pct = input.tp1Pct ?? 0;
    const fraction = input.tp1SellFraction ?? 0.5;
    if (!input.tp1Taken && tp1Pct > 0 && fraction > 0 && mark / entry >= 1 + tp1Pct / 100) {
      return { signal: "tp", fraction: Math.min(1, fraction) };
    }
  }
  const liqDropPct = input.liqDropPct ?? 20;
  if (input.useStreamLiquidity !== false && reservesDropped(input.entryVSolSol, input.lastVSolSol, liqDropPct)) {
    return { signal: "liquidity_drop", fraction: FULL_EXIT_FRACTION };
  }
  const sells = input.sellsInWindow ?? 0;
  const buys = input.buysInWindow ?? 0;
  const ratio = input.sellPressureRatio ?? 3;
  const minSells = input.minPressureSells ?? 4;
  if (sells >= minSells && sells >= ratio * buys) {
    return { signal: "sell_pressure", fraction: FULL_EXIT_FRACTION };
  }
  const lastTradeAtMs = input.lastTradeAtMs ?? input.nowMs;
  const volumeStallMs = input.volumeStallMs ?? Number.POSITIVE_INFINITY;
  const graceMs = input.volumeStallGraceMs ?? 0;
  const stallAnchorMs = Math.max(input.openedAtMs + graceMs, lastTradeAtMs);
  if (input.nowMs - stallAnchorMs >= volumeStallMs) {
    return { signal: "volume_stall", fraction: FULL_EXIT_FRACTION };
  }
  if (input.nowMs - input.openedAtMs >= input.maxHoldMs) {
    return { signal: "timeout", fraction: FULL_EXIT_FRACTION };
  }
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
