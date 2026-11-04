import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SniperBot } from "../src/bot.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { FilterDecision } from "../src/filter.js";
import { Logger } from "../src/logger.js";
import { PositionBook } from "../src/positions.js";
import { TradeLog } from "../src/report.js";
import type { Executor, FillResult, MarketLaunch, MarketTrade, OrderRequest } from "../src/types.js";

function launch(partial: Partial<MarketLaunch> = {}): MarketLaunch {
  return {
    kind: "launch",
    mint: "Mint111",
    name: "Name",
    symbol: "SYM",
    creator: "Creator",
    signature: "sig",
    initialBuyTokens: 1_000_000,
    quoteMint: "So11111111111111111111111111111111111111112",
    solQuoted: true,
    priceSol: 0.00000003,
    marketCapSol: 30,
    bondingCurveKey: null,
    ...partial,
  };
}

function fill(partial: Partial<FillResult>): FillResult {
  return {
    status: "filled",
    signature: "paper",
    solscan: null,
    price: 1,
    sizeSol: 0.1,
    tokenAmount: 1_000,
    feesSol: 0.001,
    jitoTipSol: 0.002,
    cashflowSol: 0.102,
    error: null,
    ...partial,
  };
}

function harness(options: {
  history?: FilterDecision;
  buy?: (order: OrderRequest) => Promise<FillResult>;
  sell?: (order: OrderRequest) => Promise<FillResult>;
  config?: Partial<AppConfig>;
}) {
  const dir = mkdtempSync(join(tmpdir(), "sniper-bot-"));
  const config = { ...loadConfig({ DATA_DIR: dir }), ...options.config, dataDir: dir };
  config.tradesPath = join(dir, "trades.jsonl");
  config.positionsPath = join(dir, "positions.json");
  const positions = new PositionBook(config.positionsPath);
  const trades = new TradeLog(config.tradesPath);
  const sells: OrderRequest[] = [];
  const executor: Executor = {
    buy: options.buy ?? (async () => fill({})),
    sell: async (order) => {
      sells.push(order);
      return options.sell ? options.sell(order) : fill({ price: order.quotePriceSol, cashflowSol: 0.2, sizeSol: 0.2 });
    },
  };
  const bot = new SniperBot({
    config,
    executor,
    history: { async lookup() { return options.history ?? { ok: true }; } },
    positions,
    trades,
    log: new Logger(),
    solUsd: () => 100,
    now: () => new Date("2026-11-04T12:00:00.000Z"),
    sleep: async () => {},
    subscribeMint: () => {},
  });
  return { bot, positions, trades, sells, config };
}

test("a failed buy is logged and does not open a position", async () => {
  const { bot, positions, trades } = harness({
    buy: async () => fill({ status: "failed", tokenAmount: 0, cashflowSol: 0, error: "bundle-not-landed", price: 0 }),
  });
  await bot.onLaunch(launch());
  assert.equal(positions.list().length, 0);
  const rows = trades.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "failed");
  assert.equal(rows[0]?.side, "buy");
});

test("one filled buy per mint, then a take-profit sells the whole position", async () => {
  const { bot, positions, trades, sells } = harness({});
  await bot.onLaunch(launch());
  await bot.onLaunch(launch());
  assert.equal(positions.list().length, 1);
  assert.equal(trades.readAll().filter((row) => row.side === "buy" && row.status === "filled").length, 1);

  const trade: MarketTrade = {
    kind: "trade",
    mint: "Mint111",
    txType: "buy",
    trader: "someone",
    signature: "t",
    solQuoted: true,
    priceSol: 2,
    marketCapSol: 60,
  };
  await bot.onTrade(trade);
  assert.equal(positions.list().length, 0);
  assert.equal(sells.length, 1);
  assert.equal(sells[0]?.reason, "tp");
  assert.equal(sells[0]?.tokenAmount, 1_000);
  const sellRow = trades.readAll().find((row) => row.side === "sell");
  assert.equal(sellRow?.reason, "tp");
  assert.equal(sellRow?.status, "filled");
  assert.ok((sellRow?.realizedPnlSol ?? 0) > 0);
});

test("stop loss retries a failed sell and keeps the position until it lands", async () => {
  let attempts = 0;
  const { bot, positions, trades } = harness({
    sell: async (order) => {
      attempts += 1;
      if (attempts < 3) return fill({ status: "failed", error: "timeout", price: 0, cashflowSol: 0, tokenAmount: 0 });
      return fill({ price: order.quotePriceSol, cashflowSol: 0.05, sizeSol: 0.05 });
    },
  });
  await bot.onLaunch(launch());
  await bot.onTrade({
    kind: "trade",
    mint: "Mint111",
    txType: "sell",
    trader: "someone",
    signature: "t",
    solQuoted: true,
    priceSol: 0.8,
    marketCapSol: 20,
  });
  assert.equal(attempts, 3);
  assert.equal(positions.list().length, 0);
  const failed = trades.readAll().filter((row) => row.side === "sell" && row.status === "failed");
  assert.equal(failed.length, 2);
  assert.equal(failed[0]?.reason, "sl");
});

test("a creator hold or history skip is logged and not bought", async () => {
  const heavy = harness({});
  let buys = 0;
  const { bot, trades } = harness({
    history: { ok: false, reason: "creator-dev-dump mint=old" },
    buy: async () => {
      buys += 1;
      return fill({});
    },
  });
  await bot.onLaunch(launch({ initialBuyTokens: 100_000_000 }));
  await heavy.bot.onLaunch(launch({ mint: "Other", initialBuyTokens: 1 }));
  await bot.onLaunch(launch({ mint: "Hist", initialBuyTokens: 1 }));
  assert.equal(buys, 0);
  assert.equal(heavy.positions.list().length, 1);
  assert.ok(trades.readAll().every((row) => row.side !== "buy" || row.mint === "never"));
});
