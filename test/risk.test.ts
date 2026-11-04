import assert from "node:assert/strict";
import { test } from "node:test";
import { decideExit, exitSignal, FULL_EXIT_FRACTION } from "../src/risk.js";

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

test("a missing price does not exit", () => {
  assert.equal(exitSignal(0, 1, 50, 15), null);
  assert.equal(exitSignal(1, 0, 50, 15), null);
});
