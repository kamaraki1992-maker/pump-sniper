import assert from "node:assert/strict";
import { test } from "node:test";
import { decideExit, exitSignal, FULL_EXIT_FRACTION, nextTrailFloor, type TrailTier } from "../src/risk.js";

const tiers: TrailTier[] = [
  { activatePct: 15, floorPct: 5 },
  { activatePct: 30, floorPct: 15 },
  { activatePct: 50, floorPct: 35 },
  { activatePct: 100, floorPct: 75 },
];

test("take profit sells 100% at +50% and not before", () => {
  assert.equal(FULL_EXIT_FRACTION, 1);
  assert.equal(exitSignal(1, 1.5, 50, 15), "tp");
  assert.equal(exitSignal(1, 2, 50, 15), "tp");
  assert.equal(exitSignal(1, 1.49, 50, 15), null);
});

test("stop loss sells 100% at -15% and not before", () => {
  assert.equal(exitSignal(1, 0.85, 50, 15), "sl");
  assert.equal(exitSignal(1, 0.5, 50, 15), "sl");
  assert.equal(exitSignal(1, 0.86, 50, 15), null);
});

test("take profit and stop loss outrank a hold that has already expired", () => {
  const expired = { openedAtMs: 0, nowMs: 10 * 60_000, maxHoldMs: 10 * 60_000 };
  assert.equal(decideExit({ entryPrice: 1, markPrice: 1.5, takeProfitPct: 50, stopLossPct: 15, ...expired }), "tp");
  assert.equal(decideExit({ entryPrice: 1, markPrice: 0.85, takeProfitPct: 50, stopLossPct: 15, ...expired }), "sl");
  assert.equal(decideExit({ entryPrice: 1, markPrice: 1, takeProfitPct: 50, stopLossPct: 15, ...expired }), "timeout");
  assert.equal(
    decideExit({ entryPrice: 1, markPrice: 1, takeProfitPct: 50, stopLossPct: 15, openedAtMs: 0, nowMs: 10 * 60_000 - 1, maxHoldMs: 10 * 60_000 }),
    null,
  );
});

test("take profit at 0 is disabled and does not sell a flat or higher mark", () => {
  assert.equal(exitSignal(1, 1, 0, 15), null);
  assert.equal(exitSignal(1, 1.5, 0, 15), null);
  assert.equal(exitSignal(1, 2, 0, 15), null);
  assert.equal(exitSignal(1, 0.85, 0, 15), "sl");
});

test("each profit-lock tier ratchets the floor and never lowers it", () => {
  assert.equal(nextTrailFloor(1, 1.14, tiers, null), null);
  assert.equal(nextTrailFloor(1, 1.15, tiers, null), 5);
  assert.equal(nextTrailFloor(1, 1.29, tiers, null), 5);
  assert.equal(nextTrailFloor(1, 1.3, tiers, null), 15);
  assert.equal(nextTrailFloor(1, 1.5, tiers, null), 35);
  assert.equal(nextTrailFloor(1, 2, tiers, null), 75);
  assert.equal(nextTrailFloor(1, 1.4, tiers, 75), 75);
  assert.equal(nextTrailFloor(1, 1.1, tiers, 35), 35);
});

test("a locked floor sells at entry times that floor, and take profit still wins when it is on", () => {
  const held = {
    entryPrice: 1,
    takeProfitPct: 0,
    stopLossPct: 15,
    openedAtMs: 0,
    nowMs: 1_000,
    maxHoldMs: 10 * 60_000,
  };
  assert.equal(decideExit({ ...held, markPrice: 1.3, trailFloorPct: 15 }), null);
  assert.equal(decideExit({ ...held, markPrice: 1.05, trailFloorPct: 5 }), "trailing_stop");
  assert.equal(decideExit({ ...held, markPrice: 1.06, trailFloorPct: 5 }), null);
  assert.equal(decideExit({ ...held, markPrice: 1.15, trailFloorPct: 15 }), "trailing_stop");
  assert.equal(decideExit({ ...held, markPrice: 1.5, trailFloorPct: 35 }), null);
  assert.equal(decideExit({ ...held, markPrice: 1.35, trailFloorPct: 35 }), "trailing_stop");
  assert.equal(decideExit({ ...held, markPrice: 2, trailFloorPct: 75 }), null);
  assert.equal(decideExit({ ...held, markPrice: 1.75, trailFloorPct: 75 }), "trailing_stop");
  assert.equal(decideExit({ ...held, markPrice: 1.4, trailFloorPct: 75 }), "trailing_stop");
  assert.equal(decideExit({ ...held, markPrice: 0.85, trailFloorPct: null }), "sl");
  assert.equal(
    decideExit({ ...held, markPrice: 1.5, trailFloorPct: 75, takeProfitPct: 50 }),
    "tp",
  );
});

test("volume stall waits out the grace, then the silence window", () => {
  const quiet = {
    entryPrice: 1,
    markPrice: 1,
    takeProfitPct: 0,
    stopLossPct: 15,
    openedAtMs: 0,
    maxHoldMs: 10 * 60_000,
    lastTradeAtMs: 0,
    volumeStallMs: 45_000,
    volumeStallGraceMs: 90_000,
  };
  assert.equal(decideExit({ ...quiet, nowMs: 45_000 }), null);
  assert.equal(decideExit({ ...quiet, nowMs: 134_000 }), null);
  assert.equal(decideExit({ ...quiet, nowMs: 135_000 }), "volume_stall");
  assert.equal(decideExit({ ...quiet, lastTradeAtMs: 30_000, nowMs: 135_000 }), "volume_stall");
  assert.equal(decideExit({ ...quiet, lastTradeAtMs: 100_000, nowMs: 144_000 }), null);
  assert.equal(decideExit({ ...quiet, lastTradeAtMs: 100_000, nowMs: 145_000 }), "volume_stall");
  assert.equal(decideExit({ ...quiet, markPrice: 0.85, nowMs: 10_000 }), "sl");
});

test("a missing price does not exit", () => {
  assert.equal(exitSignal(0, 1, 50, 15), null);
  assert.equal(exitSignal(1, 0, 50, 15), null);
});
