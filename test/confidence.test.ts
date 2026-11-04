import assert from "node:assert/strict";
import { test } from "node:test";
import { confidenceScore, sizeFromConfidence } from "../src/confidence.js";

test("confidence maps linearly between the buy size bounds", () => {
  const clean = confidenceScore({ holdPct: 0, buys: 0, sells: 0, safetyOk: true });
  assert.ok(Math.abs(clean - 0.85) < 1e-12);
  assert.ok(Math.abs(sizeFromConfidence(clean, 5, 30) - 26.25) < 1e-12);
  assert.equal(sizeFromConfidence(0, 5, 30), 5);
  assert.equal(sizeFromConfidence(1, 5, 30), 30);

  const unsafe = confidenceScore({ holdPct: 10, buys: 1, sells: 9, safetyOk: false });
  assert.ok(unsafe < clean);
  assert.ok(Math.abs(unsafe - (0.3 * (1 / 10))) < 1e-12);
});
