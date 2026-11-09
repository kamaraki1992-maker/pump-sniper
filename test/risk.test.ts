import assert from "node:assert/strict";
import { test } from "node:test";
import { decideExit, FULL_EXIT_FRACTION, ratchetStop, stopLossPrice, trailStopPrice, type ExitPlan } from "../src/risk.js";

const held = {
  entryPrice: 1,
  stopLossPct: 20,
  openedAtMs: 0,
  nowMs: 1_000,
  maxHoldMs: 10 * 60_000,
  tp1Pct: 100,
  tp1SellFraction: 0.5,
  tp1Taken: false,
};

function signal(plan: ExitPlan | null): string | null {
  return plan?.signal ?? null;
}

test("stop loss sells 100% at -20% from the entry fill and not before", () => {
  assert.equal(FULL_EXIT_FRACTION, 1);
  assert.equal(stopLossPrice(1, 20), 0.8);
  assert.equal(signal(decideExit({ ...held, markPrice: 0.8 })), "sl");
  assert.equal(decideExit({ ...held, markPrice: 0.8 })?.fraction, 1);
  assert.equal(signal(decideExit({ ...held, markPrice: 0.5 })), "sl");
  assert.equal(decideExit({ ...held, markPrice: 0.81 }), null);
});

test("take profit and stop loss outrank a hold that has already expired", () => {
  const expired = { openedAtMs: 0, nowMs: 10 * 60_000, maxHoldMs: 10 * 60_000 };
  assert.equal(signal(decideExit({ ...held, markPrice: 2, ...expired })), "tp");
  assert.equal(decideExit({ ...held, markPrice: 2, ...expired })?.fraction, 0.5);
  assert.equal(signal(decideExit({ ...held, markPrice: 0.8, ...expired })), "sl");
  assert.equal(signal(decideExit({ ...held, markPrice: 1, ...expired })), "timeout");
  assert.equal(
    decideExit({ ...held, markPrice: 1, openedAtMs: 0, nowMs: 10 * 60_000 - 1, maxHoldMs: 10 * 60_000 }),
    null,
  );
});

test("break-even is the floor and a 20% trail ratchets above it after +50%", () => {
  assert.equal(trailStopPrice(1, 1.49, 50, 20), null);
  const armed = trailStopPrice(1, 1.5, 50, 20);
  assert.ok(armed != null && Math.abs(armed - 1.2) < 1e-12);
  assert.ok(armed >= 1);
  assert.ok(Math.abs((trailStopPrice(1, 2, 50, 20) ?? 0) - 1.6) < 1e-12);
  assert.equal(trailStopPrice(1, 1.5, 50, 80), 1);
  assert.equal(ratchetStop(1.6, trailStopPrice(1, 1.7, 50, 20)), 1.6);
  const higher = ratchetStop(1.6, trailStopPrice(1, 3, 50, 20));
  assert.ok(higher != null && Math.abs(higher - 2.4) < 1e-12);
});

test("the armed trail sells on a 20% giveback and the 2x partial does not repeat", () => {
  const stop = trailStopPrice(1, 1.5, 50, 20);
  assert.equal(signal(decideExit({ ...held, markPrice: 1.2, trailStopPriceSol: stop })), "trailing_stop");
  assert.equal(decideExit({ ...held, markPrice: 1.21, trailStopPriceSol: stop }), null);
  assert.equal(decideExit({ ...held, markPrice: 1, trailStopPriceSol: null }), null);
  const atTwo = decideExit({ ...held, markPrice: 2, trailStopPriceSol: 1.6 });
  assert.equal(atTwo?.signal, "tp");
  assert.equal(atTwo?.fraction, 0.5);
  assert.equal(decideExit({ ...held, markPrice: 2, trailStopPriceSol: 1.6, tp1Taken: true }), null);
  assert.equal(
    signal(decideExit({ ...held, markPrice: 1.6, trailStopPriceSol: 1.6, tp1Taken: true })),
    "trailing_stop",
  );
});

test("volume stall waits out the grace, then the silence window", () => {
  const quiet = {
    ...held,
    markPrice: 1,
    lastTradeAtMs: 0,
    volumeStallMs: 45_000,
    volumeStallGraceMs: 90_000,
  };
  assert.equal(decideExit({ ...quiet, nowMs: 45_000 }), null);
  assert.equal(decideExit({ ...quiet, nowMs: 134_000 }), null);
  assert.equal(signal(decideExit({ ...quiet, nowMs: 135_000 })), "volume_stall");
  assert.equal(signal(decideExit({ ...quiet, lastTradeAtMs: 30_000, nowMs: 135_000 })), "volume_stall");
  assert.equal(decideExit({ ...quiet, lastTradeAtMs: 100_000, nowMs: 144_000 }), null);
  assert.equal(signal(decideExit({ ...quiet, lastTradeAtMs: 100_000, nowMs: 145_000 })), "volume_stall");
  assert.equal(signal(decideExit({ ...quiet, markPrice: 0.8, nowMs: 10_000 })), "sl");
});

test("a missing price does not exit", () => {
  assert.equal(decideExit({ ...held, entryPrice: 0, markPrice: 1 }), null);
  assert.equal(decideExit({ ...held, markPrice: 0 }), null);
});
