import assert from "node:assert/strict";
import { test } from "node:test";
import { assessMark, curveSellPrice, PUMP_CURVE_K } from "../src/pricing.js";

/** Microsoft in the 4 Nov 2026 paper run: launch quote, then a 1574 SOL "mark". */
const LAUNCH_VTOKENS = 1_073_000_000;
const LAUNCH_VSOL = 30;
const LAUNCH_QUOTE = LAUNCH_VSOL / LAUNCH_VTOKENS;
const MICROSOFT_MCAP = 1574.2135076795605;
const MICROSOFT_MARK = MICROSOFT_MCAP / 1e9;

test("a 54x stream mark is rejected when the bonding curve is still at launch", () => {
  assert.ok(Math.abs(LAUNCH_VSOL * LAUNCH_VTOKENS - PUMP_CURVE_K) < 1);
  const decision = assessMark({
    previous: LAUNCH_QUOTE,
    proposed: MICROSOFT_MARK,
    vSol: LAUNCH_VSOL,
    vTokens: LAUNCH_VTOKENS,
    nextVSol: LAUNCH_VSOL,
    nextVTokens: LAUNCH_VTOKENS,
  });
  assert.equal(decision.accept, false);
  assert.ok(MICROSOFT_MARK / LAUNCH_QUOTE > 50);

  const execution = curveSellPrice(LAUNCH_VSOL, LAUNCH_VTOKENS, 1_832_118.6499291072);
  assert.ok(execution != null);
  assert.ok(execution! < LAUNCH_QUOTE);
  assert.ok(execution! > LAUNCH_QUOTE / 2);
  assert.ok(MICROSOFT_MARK / execution! > 50);
});

test("a mark that jumps more than 5x in one update is rejected", () => {
  const rejected = assessMark({
    previous: 1e-8,
    proposed: 6e-8,
    vSol: null,
    vTokens: null,
  });
  assert.equal(rejected.accept, false);

  const accepted = assessMark({
    previous: 1e-8,
    proposed: 4e-8,
    vSol: null,
    vTokens: null,
  });
  assert.equal(accepted.accept, true);
  assert.equal(accepted.price, 4e-8);
});
