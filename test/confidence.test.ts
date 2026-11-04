import assert from "node:assert/strict";
import { test } from "node:test";
import { confidenceScore, sizeFromConfidence } from "../src/confidence.js";

const MIN = 5;
const MAX = 30;

function usd(input: { holdPct: number; buys: number; sells: number; safetyOk: boolean }): number {
  return sizeFromConfidence(confidenceScore(input), MIN, MAX);
}

test("ordinary launches land near $10 and only strong flow reaches the top", () => {
  const ordinary = [
    { holdPct: 0, buys: 0, sells: 0, safetyOk: true },
    { holdPct: 0.4, buys: 0, sells: 0, safetyOk: true },
    { holdPct: 0.8, buys: 0, sells: 0, safetyOk: true },
    { holdPct: 1.2, buys: 0, sells: 0, safetyOk: true },
    { holdPct: 1.6, buys: 0, sells: 0, safetyOk: true },
    { holdPct: 2, buys: 0, sells: 0, safetyOk: true },
    { holdPct: 2.4, buys: 0, sells: 0, safetyOk: true },
    { holdPct: 3, buys: 0, sells: 0, safetyOk: true },
  ];
  const sizes = ordinary.map(usd).sort((a, b) => a - b);
  const median = (sizes[3]! + sizes[4]!) / 2;
  assert.ok(median > 9.5 && median < 10.5, `median ${median}`);
  assert.ok(sizes.every((size) => size >= 8 && size <= 15));
  assert.ok(Math.abs(usd({ holdPct: 0, buys: 0, sells: 0, safetyOk: true }) - 12) < 1e-9);
  assert.equal(usd({ holdPct: 0, buys: 10, sells: 0, safetyOk: false }), 5);

  const strong = usd({ holdPct: 1, buys: 5, sells: 1, safetyOk: true });
  assert.ok(strong >= 20 && strong < 30);
  const allStrong = usd({ holdPct: 0, buys: 40, sells: 0, safetyOk: true });
  assert.equal(allStrong, 30);
  assert.equal(sizeFromConfidence(1, MIN, MAX), 30);
});
