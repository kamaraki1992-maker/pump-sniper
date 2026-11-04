import assert from "node:assert/strict";
import { test } from "node:test";
import { exitSignal, FULL_EXIT_FRACTION } from "../src/risk.js";

test("take profit sells 100% at +100% and not before", () => {
  assert.equal(FULL_EXIT_FRACTION, 1);
  assert.equal(exitSignal(1, 2, 100, 20), "tp");
  assert.equal(exitSignal(1, 2.5, 100, 20), "tp");
  assert.equal(exitSignal(1, 1.99, 100, 20), null);
});

test("stop loss sells 100% at -20% and not before", () => {
  assert.equal(exitSignal(1, 0.8, 100, 20), "sl");
  assert.equal(exitSignal(1, 0.5, 100, 20), "sl");
  assert.equal(exitSignal(1, 0.81, 100, 20), null);
});

test("a missing price does not exit", () => {
  assert.equal(exitSignal(0, 1, 100, 20), null);
  assert.equal(exitSignal(1, 0, 100, 20), null);
});
