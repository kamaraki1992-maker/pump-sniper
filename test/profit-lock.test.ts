import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SniperBot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { PositionBook } from "../src/positions.js";
import { TradeLog } from "../src/report.js";
import type { FillResult, MarketLaunch, MarketTrade, OrderRequest } from "../src/types.js";

test("a paper profit lock sells at the trigger print with sell slippage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "profit-lock-"));
  const config = loadConfig({
    DATA_DIR: dir,
    PROFIT_LOCK_TRIGGER_PCT: "20",
    PROFIT_LOCK_FLOOR_PCT: "10",
  });
  config.dataDir = dir;
  config.tradesPath = join(dir, "trades.jsonl");
  config.positionsPath = join(dir, "positions.json");
  config.entryWatchMaxSec = 0;
  config.earlyExitWindowSec = 0;
  const sells: OrderRequest[] = [];
  const trades = new TradeLog(config.tradesPath);
  const positions = new PositionBook(config.positionsPath);
  const fill: FillResult = {
    status: "filled",
    signature: "paper",
    solscan: null,
    price: 1,
    sizeSol: 0.03,
    tokenAmount: 1_000,
    feesSol: 0,
    jitoTipSol: 0.001,
    cashflowSol: 0.03,
    error: null,
  };
  const bot = new SniperBot({
    config,
    executor: {
      buy: async () => fill,
      sell: async (order) => {
        sells.push(order);
        return { ...fill, price: order.quotePriceSol * (1 - order.slippagePct / 100), cashflowSol: 0.04 };
      },
    },
    history: { lookup: async () => ({ ok: true }) },
    positions,
    trades,
    log: new Logger(),
    solUsd: () => 100,
    solQuote: () => ({ usd: 100, updatedAtMs: Date.parse("2026-11-10T12:00:00.000Z") }),
    now: () => new Date("2026-11-10T12:00:00.000Z"),
    sleep: async () => {},
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
  });
  const launch: MarketLaunch = {
    kind: "launch",
    mint: "Lock",
    name: "N",
    symbol: "S",
    creator: "Creator",
    signature: "sig",
    initialBuyTokens: 1_000_000,
    quoteMint: null,
    solQuoted: true,
    priceSol: 1,
    marketCapSol: 30,
    vSolSol: 30,
    vTokens: 1_073_000_000,
    bondingCurveKey: null,
  };
  await bot.onLaunch(launch);
  const print = (price: number, signature: string): MarketTrade => ({
    kind: "trade",
    mint: "Lock",
    txType: "buy",
    trader: "buyer",
    signature,
    solQuoted: true,
    priceSol: price,
    marketCapSol: price * 1e9,
    vSolSol: 30,
    vTokens: 1_073_000_000,
  });
  await bot.onTrade(print(1.2, "peak"));
  assert.equal(sells.length, 0);
  assert.ok(Math.abs((positions.get("Lock")?.profitLockPriceSol ?? 0) - 1.1) < 1e-12);
  await bot.onTrade(print(1.1, "giveback"));
  assert.equal(trades.readAll().find((row) => row.side === "sell")?.reason, "profit_lock");
  assert.equal(sells[0]?.quotePriceSol, 1.1);
  assert.equal(sells[0]?.useQuotedSlippage, true);
  assert.equal(sells[0]?.slippagePct, config.sellSlippagePct);
});
