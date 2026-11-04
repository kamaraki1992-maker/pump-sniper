import assert from "node:assert/strict";
import { test } from "node:test";
import { assessMark, curveSellPrice, parsePumpDevMessage, poolSellPrice, PUMP_CURVE_K } from "../src/pricing.js";
import { curveCompleteFlag } from "../src/curve-watch.js";

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

test("complete and create_pool graduate, and a pool sell does not use the curve price", () => {
  const complete = parsePumpDevMessage({ txType: "complete", mint: "MintA" });
  assert.equal(complete?.kind, "graduation");
  const created = parsePumpDevMessage({
    txType: "create_pool",
    mint: "MintA",
    pool: "Pool111",
    poolBaseReservesUi: 206_900_000,
    poolQuoteReservesUi: 85,
  });
  assert.equal(created?.kind, "graduation");
  if (created?.kind !== "graduation") return;
  assert.equal(created.pool, "Pool111");
  assert.equal(created.baseTokens, 206_900_000);
  assert.equal(created.quoteSol, 85);
  const curve = curveSellPrice(30, 1_073_000_000, 1_000);
  const pool = poolSellPrice(206_900_000, 85, 1_000);
  assert.ok(curve != null && pool != null);
  assert.ok(Math.abs(pool! - curve!) / curve! > 0.5);

  const data = new Uint8Array(49);
  assert.equal(curveCompleteFlag(data), false);
  data[48] = 1;
  assert.equal(curveCompleteFlag(data), true);
});
