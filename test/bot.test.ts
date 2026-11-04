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

class ListLogger extends Logger {
  readonly entries: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  override info(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ message, fields });
  }
}

function harness(options: {
  history?: FilterDecision;
  buy?: (order: OrderRequest) => Promise<FillResult>;
  sell?: (order: OrderRequest) => Promise<FillResult>;
  config?: Partial<AppConfig>;
  walletBalanceSol?: () => Promise<number>;
  capture?: boolean;
  now?: () => Date;
}) {
  const dir = mkdtempSync(join(tmpdir(), "sniper-bot-"));
  const config = { ...loadConfig({ DATA_DIR: dir }), ...options.config, dataDir: dir };
  config.tradesPath = join(dir, "trades.jsonl");
  config.positionsPath = join(dir, "positions.json");
  const positions = new PositionBook(config.positionsPath);
  const trades = new TradeLog(config.tradesPath);
  const sells: OrderRequest[] = [];
  const log = options.capture ? new ListLogger() : new Logger();
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
    log,
    solUsd: () => 100,
    now: options.now ?? (() => new Date("2026-11-04T12:00:00.000Z")),
    sleep: async () => {},
    subscribeMint: () => {},
    ...(options.walletBalanceSol ? { walletBalanceSol: options.walletBalanceSol } : {}),
  });
  return { bot, positions, trades, sells, config, log };
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

test("two launches in the same tick reserve one slot", async () => {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const { bot, positions, log } = harness({
    capture: true,
    buy: async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return fill({});
    },
  });
  await Promise.all([
    bot.onLaunch(launch({ mint: "MintA" })),
    bot.onLaunch(launch({ mint: "MintB" })),
  ]);
  assert.equal(calls, 1);
  assert.equal(maxInFlight, 1);
  assert.equal(positions.list().length, 1);
  const capped = (log as ListLogger).entries.filter((entry) => entry.fields?.reason === "max_open_positions");
  assert.equal(capped.length, 1);
});

test("a failed buy releases the pending slot", async () => {
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const buys: string[] = [];
  const { bot, positions } = harness({
    buy: async (order) => {
      buys.push(order.mint);
      if (order.mint === "MintA") {
        await gate;
        return fill({ status: "failed", tokenAmount: 0, cashflowSol: 0, price: 0, error: "bundle-not-landed" });
      }
      return fill({});
    },
  });
  const first = bot.onLaunch(launch({ mint: "MintA" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await bot.onLaunch(launch({ mint: "MintB" }));
  assert.deepEqual(buys, ["MintA"]);
  assert.equal(positions.list().length, 0);
  releaseFirst();
  await first;
  assert.equal(positions.list().length, 0);
  await bot.onLaunch(launch({ mint: "MintC" }));
  assert.deepEqual(buys, ["MintA", "MintC"]);
  assert.equal(positions.list().length, 1);
  assert.equal(positions.get("MintC")?.tokenAmount, 1_000);
});

test("the max-open skip log is rate limited", async () => {
  const { bot, log } = harness({ capture: true });
  await bot.onLaunch(launch({ mint: "Held" }));
  await bot.onLaunch(launch({ mint: "Next1" }));
  await bot.onLaunch(launch({ mint: "Next2" }));
  await bot.onLaunch(launch({ mint: "Next3" }));
  const capped = (log as ListLogger).entries.filter((entry) => entry.fields?.reason === "max_open_positions");
  assert.equal(capped.length, 1);
});

test("live mode skips a buy the wallet cannot cover, and paper mode does not", async () => {
  let liveBuys = 0;
  const poor = harness({
    capture: true,
    config: { mode: "live" },
    walletBalanceSol: async () => 0.05,
    buy: async () => {
      liveBuys += 1;
      return fill({});
    },
  });
  await poor.bot.onLaunch(launch({ mint: "Poor" }));
  assert.equal(liveBuys, 0);
  assert.equal(poor.positions.list().length, 0);
  const skipped = (poor.log as ListLogger).entries.filter((entry) => entry.fields?.reason === "insufficient_balance");
  assert.equal(skipped.length, 1);
  const required = skipped[0]?.fields?.requiredSol;
  assert.equal(typeof required, "number");
  assert.ok((required as number) > 0.1);

  const funded = harness({
    config: { mode: "live" },
    walletBalanceSol: async () => 1,
  });
  await funded.bot.onLaunch(launch({ mint: "Funded" }));
  assert.equal(funded.positions.list().length, 1);

  let paperBuys = 0;
  const paper = harness({
    walletBalanceSol: async () => 0,
    buy: async () => {
      paperBuys += 1;
      return fill({});
    },
  });
  await paper.bot.onLaunch(launch({ mint: "Paper" }));
  assert.equal(paperBuys, 1);
  assert.equal(paper.positions.list().length, 1);
});

test("a quiet position times out with no price update, and the slot frees only after the sell fills", async () => {
  let now = Date.parse("2026-11-04T12:00:00.000Z");
  let attempts = 0;
  const { bot, positions, trades } = harness({
    now: () => new Date(now),
    config: { sellMaxAttempts: 1 },
    buy: async () => fill({ price: 1 }),
    sell: async () => {
      attempts += 1;
      if (attempts === 1) {
        return fill({ status: "failed", error: "bundle-not-landed", price: 0, cashflowSol: 0, tokenAmount: 0 });
      }
      return fill({ price: 1, cashflowSol: 0.09, sizeSol: 0.09 });
    },
  });
  await bot.onLaunch(launch({ mint: "Quiet", priceSol: 1 }));
  await bot.checkHolds();
  assert.equal(attempts, 0);
  assert.equal(positions.list().length, 1);

  now += 10 * 60_000;
  await bot.checkHolds();
  assert.equal(attempts, 1);
  assert.equal(positions.list().length, 1);
  const failed = trades.readAll().find((row) => row.reason === "timeout" && row.status === "failed");
  assert.ok(failed);

  await bot.onLaunch(launch({ mint: "Blocked", priceSol: 1 }));
  assert.equal(positions.get("Blocked"), undefined);

  now += 6_000;
  await bot.checkHolds();
  assert.equal(positions.list().length, 0);
  const filled = trades.readAll().find((row) => row.reason === "timeout" && row.status === "filled");
  assert.ok(filled);

  await bot.onLaunch(launch({ mint: "Next", priceSol: 1 }));
  assert.equal(positions.list().length, 1);
  assert.equal(positions.get("Next")?.mint, "Next");
});

test("take profit and stop loss beat a hold that has already expired", async () => {
  let now = Date.parse("2026-11-04T12:00:00.000Z");
  const up = harness({
    now: () => new Date(now),
    buy: async () => fill({ price: 1 }),
  });
  await up.bot.onLaunch(launch({ mint: "Up", priceSol: 1.5 }));
  now += 10 * 60_000;
  await up.bot.checkHolds();
  assert.equal(up.trades.readAll().find((row) => row.side === "sell")?.reason, "tp");

  const down = harness({
    now: () => new Date(now),
    buy: async () => fill({ price: 1 }),
  });
  await down.bot.onLaunch(launch({ mint: "Down", priceSol: 0.85 }));
  now += 10 * 60_000;
  await down.bot.checkHolds();
  assert.equal(down.trades.readAll().find((row) => row.side === "sell")?.reason, "sl");
});
