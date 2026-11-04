import assert from "node:assert/strict";
import { test } from "node:test";
import { berlinDay, summarizeDay } from "../src/report.js";
import type { TradeRecord } from "../src/types.js";

function row(partial: Partial<TradeRecord>): TradeRecord {
  return {
    timestamp: "2026-11-04T12:00:00.000Z",
    mode: "paper",
    side: "buy",
    status: "filled",
    mint: "M",
    name: "N",
    symbol: "S",
    sizeSol: 0.1,
    price: 1,
    feesSol: 0.001,
    jitoTipSol: 0.002,
    signature: "paper",
    solscan: null,
    reason: "entry",
    error: null,
    solUsd: 100,
    tokenAmount: 10,
    realizedPnlSol: null,
    costSol: 0.103,
    ...partial,
  };
}

test("Berlin calendar day owns the boundary", () => {
  assert.equal(berlinDay("2026-11-04T22:30:00.000Z"), "2026-11-04");
  assert.equal(berlinDay("2026-11-04T23:30:00.000Z"), "2026-11-05");
});

test("daily summary counts trades, wins, losses, fees, tips, and failed buys", () => {
  const summary = summarizeDay(
    [
      row({}),
      row({ side: "buy", status: "failed", feesSol: 0, jitoTipSol: 0, error: "bundle-not-landed" }),
      row({
        side: "sell",
        reason: "tp",
        sizeSol: 0.22,
        feesSol: 0.002,
        jitoTipSol: 0.002,
        realizedPnlSol: 0.05,
      }),
      row({
        side: "sell",
        reason: "sl",
        mint: "L",
        sizeSol: 0.08,
        feesSol: 0.001,
        jitoTipSol: 0.002,
        realizedPnlSol: -0.02,
      }),
      row({ timestamp: "2026-11-04T23:30:00.000Z", mint: "next-day" }),
    ],
    "2026-11-04",
  );
  assert.equal(summary.day, "2026-11-04");
  assert.equal(summary.timezone, "Europe/Berlin");
  assert.equal(summary.mode, "paper");
  assert.equal(summary.tradesTaken, 1);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.failedBuys, 1);
  assert.ok(Math.abs(summary.realizedPnlSol - 0.03) < 1e-9);
  assert.ok(Math.abs(summary.realizedPnlUsd - 3) < 1e-9);
  assert.ok(Math.abs(summary.feesSol - 0.004) < 1e-9);
  assert.ok(Math.abs(summary.tipsSol - 0.006) < 1e-9);
});
