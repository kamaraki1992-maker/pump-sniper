import assert from "node:assert/strict";
import { test } from "node:test";
import { confidenceBreakdown, confidenceScore, sizeFromConfidence } from "../src/confidence.js";

const MIN = 5;
const MAX = 30;

function usd(input: { holdPct: number; buys: number; sells: number; safetyOk: boolean }): number {
  return sizeFromConfidence(confidenceScore(input), MIN, MAX);
}

test("the curved score stays on the floor without strong flow and only tops out when every signal is strong", () => {
  const typical = [
    { holdPct: 0, buys: 0, sells: 0, safetyOk: true },
    { holdPct: 2, buys: 0, sells: 1, safetyOk: true },
    { holdPct: 1, buys: 1, sells: 1, safetyOk: true },
    { holdPct: 4, buys: 2, sells: 1, safetyOk: true },
    { holdPct: 8, buys: 1, sells: 0, safetyOk: true },
    { holdPct: 0, buys: 3, sells: 2, safetyOk: false },
    { holdPct: 5, buys: 4, sells: 3, safetyOk: true },
    { holdPct: 3, buys: 2, sells: 2, safetyOk: true },
    { holdPct: 6, buys: 5, sells: 1, safetyOk: true },
    { holdPct: 0.5, buys: 3, sells: 1, safetyOk: true },
  ];
  const sizes = typical.map(usd).sort((a, b) => a - b);
  const median = (sizes[4]! + sizes[5]!) / 2;
  assert.ok(median < 15, `median ${median}`);
  assert.ok(sizes.every((size) => size < 28));
  assert.equal(sizeFromConfidence(0, MIN, MAX), 5);
  assert.equal(sizeFromConfidence(1, MIN, MAX), 30);

  const quiet = confidenceBreakdown(typical[0]!);
  assert.equal(quiet.score, 0);
  assert.ok(quiet.raw <= 0.5);

  const unsafe = confidenceBreakdown({ holdPct: 0, buys: 10, sells: 0, safetyOk: false });
  assert.ok(unsafe.raw <= 0.5);
  assert.ok(unsafe.score <= 0.25);

  const balanced = confidenceBreakdown({ holdPct: 0, buys: 4, sells: 4, safetyOk: true });
  assert.ok(balanced.raw <= 0.5);

  const allStrong = { holdPct: 0, buys: 40, sells: 0, safetyOk: true };
  const strongUsd = usd(allStrong);
  assert.ok(strongUsd >= 28);
  assert.equal(sizes.filter((size) => size >= 28).length + (strongUsd >= 28 ? 1 : 0), 1);
});
