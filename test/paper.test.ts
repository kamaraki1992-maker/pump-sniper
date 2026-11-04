import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaperModel } from "../src/config.js";
import { PaperExecutor } from "../src/executor-paper.js";
import { paperBuy, paperSell, unrealizedPnlSol } from "../src/paper-math.js";

const model: PaperModel = {
  slippagePct: 2,
  protocolFeeBps: 100,
  venueFeeBps: 25,
  priorityFeeSol: 0.00005,
  baseFeeSol: 0.000005,
  jitoTipSol: 0.002,
};

test("paper buy applies slippage, fees, and the Jito tip", () => {
  const quote = 0.00000004;
  const buy = paperBuy(quote, 0.1, model);
  const fill = quote * 1.02;
  const tokens = (0.1 * (1 - 0.0125)) / fill;
  assert.ok(Math.abs(buy.fillPriceSol - fill) < 1e-18);
  assert.ok(Math.abs(buy.tokenAmount - tokens) < 1e-6);
  assert.ok(Math.abs(buy.feesSol - (0.1 * 0.0125 + 0.00005 + 0.000005)) < 1e-12);
  assert.equal(buy.jitoTipSol, 0.002);
  assert.ok(Math.abs(buy.costSol - (0.1 + 0.00005 + 0.000005 + 0.002)) < 1e-12);
});

test("a round trip at an unchanged quote loses the spread, fees, and tips", () => {
  const quote = 0.00000004;
  const buy = paperBuy(quote, 0.1, model);
  const sell = paperSell(quote, buy.tokenAmount, model);
  const pnl = sell.proceedsSol - buy.costSol;
  assert.ok(pnl < 0);
  assert.ok(Math.abs(unrealizedPnlSol(buy.tokenAmount, buy.costSol, quote, model) - pnl) < 1e-9);
});

test("paper executor reports signature paper and never invents a position on a bad price", async () => {
  const executor = new PaperExecutor(model);
  const missed = await executor.buy({
    mint: "M",
    name: "N",
    symbol: "S",
    creator: "C",
    sizeSol: 0.1,
    quotePriceSol: 0,
    slippagePct: 20,
    reason: "entry",
  });
  assert.equal(missed.status, "failed");
  assert.equal(missed.signature, "paper");
  assert.equal(missed.tokenAmount, 0);

  const filled = await executor.buy({
    mint: "M",
    name: "N",
    symbol: "S",
    creator: "C",
    sizeSol: 0.1,
    quotePriceSol: 0.00000004,
    slippagePct: 20,
    reason: "entry",
  });
  assert.equal(filled.status, "filled");
  assert.equal(filled.signature, "paper");
  assert.equal(filled.solscan, null);
  assert.ok(filled.tokenAmount > 0);
});
