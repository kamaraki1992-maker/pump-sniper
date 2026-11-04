import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePumpDevMessage } from "../src/pricing.js";
import { nextBackoffMs } from "../src/stream.js";

test("reconnect backoff starts at 1s and caps at 30s", () => {
  assert.equal(nextBackoffMs(0), 1_000);
  assert.equal(nextBackoffMs(1), 2_000);
  assert.equal(nextBackoffMs(2), 4_000);
  assert.equal(nextBackoffMs(10), 30_000);
});

test("a SOL create from the pumpdev socket becomes a priced launch", () => {
  const event = parsePumpDevMessage({
    txType: "create",
    signature: "sig",
    mint: "9hjuugQZ3nSHfVGzPABwCFKvkCZVeXNn6GrtDPQoam9i",
    traderPublicKey: "9NyMjr5urtKG4CYeZXhhCoAfnFCX47hjPHN7XUg7cG3f",
    name: "Furlong",
    symbol: "FURLONG",
    initialBuy: 0,
    quoteMint: "So11111111111111111111111111111111111111112",
    vTokensInBondingCurve: 1_073_000_000_000_000,
    vSolInBondingCurve: 30_000_000_000,
    marketCapSol: 27.958993476234856,
    bondingCurveKey: "curve",
  });
  assert.equal(event?.kind, "launch");
  if (event?.kind !== "launch") return;
  assert.equal(event.solQuoted, true);
  assert.equal(event.initialBuyTokens, 0);
  assert.ok(event.priceSol !== null && Math.abs(event.priceSol - 27.958993476234856 / 1e9) < 1e-18);
});

test("control frames and non-SOL quotes are not buys", () => {
  assert.equal(parsePumpDevMessage({ type: "subscribed", method: "subscribeNewToken" }), null);
  const event = parsePumpDevMessage({
    txType: "create",
    mint: "OtherMint",
    traderPublicKey: "Creator",
    quoteMint: "DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF",
    initialBuy: 0,
    marketCapQuote: 500,
  });
  assert.equal(event?.kind, "launch");
  if (event?.kind !== "launch") return;
  assert.equal(event.solQuoted, false);
});
