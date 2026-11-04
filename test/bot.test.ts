import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BoughtMints } from "../src/bought.js";
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
    vSolSol: null,
    vTokens: null,
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
  solQuote?: () => { usd: number; updatedAtMs: number } | null;
  safetyCheck?: (input: {
    mint: string;
    vSol: number | null;
    vTokens: number | null;
    spendSol: number;
  }) => Promise<{ ok: boolean; reason: string | null; latencyMs: number }>;
  curveWatch?: {
    watch(mint: string, curve: string): void;
    unwatch(mint: string): void;
    isLive(mint: string): boolean;
  };
  bought?: BoughtMints;
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
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  const bought = options.bought ?? new BoughtMints(join(dir, "bought-mints.json"));
  const bot = new SniperBot({
    config,
    executor,
    history: { async lookup() { return options.history ?? { ok: true }; } },
    positions,
    trades,
    log,
    solUsd: () => 100,
    solQuote:
      options.solQuote ??
      (() => ({
        usd: 100,
        updatedAtMs: (options.now ?? (() => new Date("2026-11-04T12:00:00.000Z")))().getTime(),
      })),
    now: options.now ?? (() => new Date("2026-11-04T12:00:00.000Z")),
    sleep: async () => {},
    subscribeMint: (mint) => {
      subscribed.push(mint);
    },
    unsubscribeMint: (mint) => {
      unsubscribed.push(mint);
    },
    bought,
    ...(options.walletBalanceSol ? { walletBalanceSol: options.walletBalanceSol } : {}),
    ...(options.safetyCheck ? { safetyCheck: options.safetyCheck } : {}),
    ...(options.curveWatch ? { curveWatch: options.curveWatch } : {}),
  });
  return { bot, positions, trades, sells, config, log, subscribed, unsubscribed, bought };
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
  const { bot, positions, trades, sells } = harness({ config: { takeProfitPct: 50 } });
  await bot.onLaunch(launch({ priceSol: 1 }));
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
    vSolSol: null,
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
    vSolSol: null,
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
    config: { maxOpenPositions: 1 },
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
    config: { maxOpenPositions: 1 },
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
  const { bot, log } = harness({ capture: true, config: { maxOpenPositions: 1 } });
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
  assert.ok((required as number) > 0.05);

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
    config: { sellMaxAttempts: 1, volumeStallSec: 100_000, maxOpenPositions: 1 },
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
    config: { takeProfitPct: 50, volumeStallSec: 100_000 },
    buy: async () => fill({ price: 1 }),
  });
  await up.bot.onLaunch(launch({ mint: "Up", priceSol: 1.5 }));
  now += 10 * 60_000;
  await up.bot.checkHolds();
  assert.equal(up.trades.readAll().find((row) => row.side === "sell")?.reason, "tp");

  const down = harness({
    now: () => new Date(now),
    config: { volumeStallSec: 100_000 },
    buy: async () => fill({ price: 1 }),
  });
  await down.bot.onLaunch(launch({ mint: "Down", priceSol: 0.85 }));
  now += 10 * 60_000;
  await down.bot.checkHolds();
  assert.equal(down.trades.readAll().find((row) => row.side === "sell")?.reason, "sl");
});

test("volume stall, liquidity drop, and sell pressure each sell once", async () => {
  let now = Date.parse("2026-11-04T12:00:00.000Z");
  const stall = harness({
    now: () => new Date(now),
    buy: async () => fill({ price: 1 }),
  });
  await stall.bot.onLaunch(launch({ mint: "Stall", priceSol: 1 }));
  now += 45_000;
  await stall.bot.checkHolds();
  assert.equal(stall.trades.readAll().find((row) => row.side === "sell"), undefined);
  now += 90_000;
  await stall.bot.checkHolds();
  assert.equal(stall.trades.readAll().find((row) => row.side === "sell")?.reason, "volume_stall");
  assert.equal(stall.positions.list().length, 0);
  assert.deepEqual(stall.unsubscribed, ["Stall"]);

  const liq = harness({
    buy: async () => fill({ price: 1 }),
  });
  await liq.bot.onLaunch(launch({ mint: "Liq", priceSol: 1, vSolSol: 30 }));
  await liq.bot.onTrade({
    kind: "trade",
    mint: "Liq",
    txType: "sell",
    trader: "x",
    signature: "s",
    solQuoted: true,
    priceSol: 1,
    marketCapSol: 28,
    vSolSol: 20,
  });
  assert.equal(liq.trades.readAll().find((row) => row.side === "sell")?.reason, "liquidity_drop");

  const pressure = harness({
    buy: async () => fill({ price: 1 }),
  });
  await pressure.bot.onLaunch(launch({ mint: "Press", priceSol: 1 }));
  for (let i = 0; i < 4; i += 1) {
    await pressure.bot.onTrade({
      kind: "trade",
      mint: "Press",
      txType: "sell",
      trader: "x",
      signature: `s${i}`,
      solQuoted: true,
      priceSol: 1,
      marketCapSol: 30,
      vSolSol: null,
    });
  }
  const sells = pressure.trades.readAll().filter((row) => row.side === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0]?.reason, "sell_pressure");
});

test("overlapping exit checks do not send two sells", async () => {
  let now = Date.parse("2026-11-04T12:00:00.000Z");
  let calls = 0;
  const { bot } = harness({
    now: () => new Date(now),
    buy: async () => fill({ price: 1 }),
    sell: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fill({ price: 1, cashflowSol: 0.09, sizeSol: 0.09 });
    },
  });
  await bot.onLaunch(launch({ mint: "Once", priceSol: 1 }));
  now += 135_000;
  await Promise.all([bot.checkHolds(), bot.checkHolds()]);
  assert.equal(calls, 1);
});

test("a curve account update sells on liquidity_drop and does not double-sell", async () => {
  let calls = 0;
  const watched: string[] = [];
  const unwatched: string[] = [];
  const { bot, trades } = harness({
    buy: async () => fill({ price: 1 }),
    sell: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fill({ price: 1, cashflowSol: 0.09, sizeSol: 0.09 });
    },
    curveWatch: {
      watch: (mint) => watched.push(mint),
      unwatch: (mint) => unwatched.push(mint),
      isLive: () => true,
    },
  });
  await bot.onLaunch(launch({ mint: "CurveMint", priceSol: 1, bondingCurveKey: "Curve111" }));
  assert.deepEqual(watched, ["CurveMint"]);
  bot.onCurveReserves("CurveMint", 10);
  await Promise.all([bot.onCurveReserves("CurveMint", 7), bot.onCurveReserves("CurveMint", 6)]);
  assert.equal(calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(trades.readAll().find((row) => row.side === "sell")?.reason, "liquidity_drop");
  assert.deepEqual(unwatched, ["CurveMint"]);
});

test("a failed safety check skips the buy and logs latency", async () => {
  let buys = 0;
  const { bot, log, positions } = harness({
    capture: true,
    buy: async () => {
      buys += 1;
      return fill({});
    },
    safetyCheck: async () => ({ ok: false, reason: "freeze-authority-set", latencyMs: 18 }),
  });
  await bot.onLaunch(launch({ mint: "Frozen", priceSol: 1 }));
  assert.equal(buys, 0);
  assert.equal(positions.list().length, 0);
  const row = (log as ListLogger).entries.find((entry) => entry.fields?.reason === "freeze-authority-set");
  assert.equal(row?.fields?.latencyMs, 18);
});

test("a buy logs USD and SOL size from a fresh SOL/USD quote and stays within $30", async () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  const { bot, log, trades } = harness({
    capture: true,
    now: () => new Date(now),
    solQuote: () => ({ usd: 100, updatedAtMs: now }),
    buy: async (order) => fill({ sizeSol: order.sizeSol, cashflowSol: order.sizeSol }),
  });
  await bot.onLaunch(launch({ mint: "Usd", priceSol: 1, initialBuyTokens: 0 }));
  const filled = (log as ListLogger).entries.find((entry) => entry.message === "buy filled");
  const sizeUsd = filled?.fields?.sizeUsd;
  const sizeSol = filled?.fields?.sizeSol;
  assert.ok(Math.abs((sizeUsd as number) - 12) < 1e-9);
  assert.ok(Math.abs((filled?.fields?.score as number) - 0.28) < 1e-9);
  assert.equal(typeof sizeSol, "number");
  assert.ok((sizeUsd as number) <= 30);
  assert.ok(Math.abs((sizeSol as number) - (sizeUsd as number) / 100) < 1e-12);
  const row = trades.readAll().find((entry) => entry.side === "buy");
  assert.equal(row?.sizeUsd, sizeUsd);
  assert.equal(row?.sizeSol, sizeSol);
});

test("missing or stale SOL/USD skips the buy with no_price", async () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  let missingBuys = 0;
  const missing = harness({
    capture: true,
    now: () => new Date(now),
    solQuote: () => null,
    buy: async () => {
      missingBuys += 1;
      return fill({});
    },
  });
  await missing.bot.onLaunch(launch({ mint: "NoQuote", priceSol: 1 }));
  assert.equal(missingBuys, 0);
  assert.ok(
    (missing.log as ListLogger).entries.some((entry) => entry.fields?.reason === "no_price"),
  );

  let staleBuys = 0;
  const stale = harness({
    capture: true,
    now: () => new Date(now),
    solQuote: () => ({ usd: 100, updatedAtMs: now - 60_001 }),
    buy: async () => {
      staleBuys += 1;
      return fill({});
    },
  });
  await stale.bot.onLaunch(launch({ mint: "Stale", priceSol: 1 }));
  assert.equal(staleBuys, 0);
  assert.equal(stale.positions.list().length, 0);
  assert.ok((stale.log as ListLogger).entries.some((entry) => entry.fields?.reason === "no_price"));

  const freshEdge = harness({
    now: () => new Date(now),
    solQuote: () => ({ usd: 100, updatedAtMs: now - 60_000 }),
  });
  await freshEdge.bot.onLaunch(launch({ mint: "Edge", priceSol: 1 }));
  assert.equal(freshEdge.positions.list().length, 1);
});

function trade(partial: Partial<MarketTrade> & { mint: string; priceSol: number }): MarketTrade {
  return {
    kind: "trade",
    mint: partial.mint,
    txType: partial.txType ?? "buy",
    trader: "x",
    signature: partial.signature ?? "t",
    solQuoted: true,
    priceSol: partial.priceSol,
    marketCapSol: 30,
    vSolSol: null,
  };
}

test("default take profit is off, and each profit-lock tier sells once at its floor", async () => {
  const tier30 = harness({ buy: async () => fill({ price: 1 }) });
  await tier30.bot.onLaunch(launch({ mint: "T30", priceSol: 1 }));
  await tier30.bot.onTrade(trade({ mint: "T30", priceSol: 1.3, signature: "peak" }));
  assert.equal(tier30.positions.get("T30")?.trailFloorPct, 15);
  assert.equal(tier30.positions.list().length, 1);
  await tier30.bot.onTrade(trade({ mint: "T30", priceSol: 1.15, signature: "out" }));
  assert.equal(tier30.trades.readAll().find((row) => row.side === "sell")?.reason, "trailing_stop");

  const tier50 = harness({ buy: async () => fill({ price: 1 }) });
  await tier50.bot.onLaunch(launch({ mint: "T50", priceSol: 1 }));
  await tier50.bot.onTrade(trade({ mint: "T50", priceSol: 1.5, signature: "peak" }));
  assert.equal(tier50.positions.list().length, 1);
  assert.equal(tier50.positions.get("T50")?.trailFloorPct, 35);
  await tier50.bot.onTrade(trade({ mint: "T50", priceSol: 1.35, signature: "out" }));
  assert.equal(tier50.trades.readAll().find((row) => row.side === "sell")?.reason, "trailing_stop");

  const tier100 = harness({ buy: async () => fill({ price: 1 }) });
  await tier100.bot.onLaunch(launch({ mint: "T100", priceSol: 1 }));
  await tier100.bot.onTrade(trade({ mint: "T100", priceSol: 2, signature: "peak" }));
  assert.equal(tier100.positions.list().length, 1);
  assert.equal(tier100.positions.get("T100")?.trailFloorPct, 75);
  await tier100.bot.onTrade(trade({ mint: "T100", priceSol: 1.4, signature: "out" }));
  assert.equal(tier100.trades.readAll().find((row) => row.side === "sell")?.reason, "trailing_stop");
});

test("an enabled take profit still sells 100% at +50%", async () => {
  const { bot, trades, positions } = harness({
    config: { takeProfitPct: 50 },
    buy: async () => fill({ price: 1 }),
  });
  await bot.onLaunch(launch({ mint: "Tp", priceSol: 1 }));
  await bot.onTrade(trade({ mint: "Tp", priceSol: 1.5, signature: "tp" }));
  assert.equal(positions.list().length, 0);
  assert.equal(trades.readAll().find((row) => row.side === "sell")?.reason, "tp");
});

test("overlapping profit-lock checks sell once", async () => {
  let calls = 0;
  const { bot, trades } = harness({
    buy: async () => fill({ price: 1 }),
    sell: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fill({ price: 1.15, cashflowSol: 0.12, sizeSol: 0.12 });
    },
  });
  await bot.onLaunch(launch({ mint: "Lock", priceSol: 1 }));
  await bot.onTrade(trade({ mint: "Lock", priceSol: 1.3, signature: "peak" }));
  await Promise.all([
    bot.onTrade(trade({ mint: "Lock", priceSol: 1.15, signature: "a" })),
    bot.onTrade(trade({ mint: "Lock", priceSol: 1.1, signature: "b" })),
  ]);
  assert.equal(calls, 1);
  assert.equal(trades.readAll().filter((row) => row.side === "sell" && row.reason === "trailing_stop").length, 1);
});

test("a trade after the grace restarts the stall window", async () => {
  let now = Date.parse("2026-11-04T12:00:00.000Z");
  const { bot, trades, positions } = harness({
    now: () => new Date(now),
    buy: async () => fill({ price: 1 }),
  });
  await bot.onLaunch(launch({ mint: "Late", priceSol: 1 }));
  now += 100_000;
  await bot.onTrade(trade({ mint: "Late", priceSol: 1, signature: "late" }));
  assert.equal(positions.list().length, 1);
  now += 44_000;
  await bot.checkHolds();
  assert.equal(trades.readAll().find((row) => row.side === "sell"), undefined);
  now += 1_000;
  await bot.checkHolds();
  assert.equal(trades.readAll().find((row) => row.side === "sell")?.reason, "volume_stall");
});

test("a failed buy releases the trade subscription", async () => {
  const failed = harness({
    buy: async () => fill({ status: "failed", error: "bundle-not-landed", price: 0, tokenAmount: 0, cashflowSol: 0 }),
  });
  await failed.bot.onLaunch(launch({ mint: "Fail", priceSol: 1 }));
  assert.deepEqual(failed.subscribed, ["Fail"]);
  assert.deepEqual(failed.unsubscribed, ["Fail"]);
});

test("market buy flow before the fill raises size", async () => {
  const { bot, log, trades } = harness({
    capture: true,
    buy: async (order) => fill({ sizeSol: order.sizeSol, cashflowSol: order.sizeSol }),
  });
  for (let i = 0; i < 40; i += 1) {
    await bot.onTrade(trade({ mint: "Hot", priceSol: 1, signature: `b${i}` }));
  }
  await bot.onLaunch(launch({ mint: "Hot", priceSol: 1, initialBuyTokens: 0 }));
  const filled = (log as ListLogger).entries.find((entry) => entry.message === "buy filled");
  assert.equal(typeof filled?.fields?.hold, "number");
  assert.equal(typeof filled?.fields?.flow, "number");
  assert.equal(filled?.fields?.safety, 1);
  assert.ok((filled?.fields?.sizeUsd as number) >= 28);
  assert.equal(trades.readAll()[0]?.confidence, filled?.fields?.score);
});

test("the same mint is not bought again after the sell or a restart, and the key is the mint", async () => {
  const first = harness({ buy: async () => fill({ price: 1 }) });
  await first.bot.onLaunch(launch({ mint: "MintA", priceSol: 1, name: "META", symbol: "META" }));
  await first.bot.onTrade(trade({ mint: "MintA", priceSol: 0.85, signature: "out", txType: "sell" }));
  assert.equal(first.positions.list().length, 0);
  await first.bot.onLaunch(launch({ mint: "MintA", priceSol: 1, name: "META", symbol: "META" }));
  assert.equal(first.trades.readAll().filter((row) => row.side === "buy" && row.status === "filled").length, 1);

  const restarted = harness({ bought: first.bought, buy: async () => fill({ price: 1 }) });
  await restarted.bot.onLaunch(launch({ mint: "MintA", priceSol: 1, name: "META", symbol: "META" }));
  assert.equal(restarted.positions.list().length, 0);
  assert.equal(restarted.trades.readAll().filter((row) => row.side === "buy").length, 0);

  await restarted.bot.onLaunch(launch({ mint: "MintB", priceSol: 1, name: "META", symbol: "META" }));
  assert.equal(restarted.positions.list().length, 1);
  assert.equal(restarted.positions.get("MintB")?.mint, "MintB");
});

test("a 54x stream mark is rejected and the paper sell uses the curve", async () => {
  let now = Date.parse("2026-11-04T20:04:15.000Z");
  const { bot, log, sells } = harness({
    capture: true,
    now: () => new Date(now),
    buy: async () => fill({ price: 2.8518173345759554e-8, tokenAmount: 1_832_118.6499291072 }),
  });
  await bot.onLaunch(
    launch({
      mint: "4313WPjwvWAMrpo1oWrW7BXGWS2nXbqj47nbMFSDpump",
      name: "Microsoft",
      priceSol: 30 / 1_073_000_000,
      vSolSol: 30,
      vTokens: 1_073_000_000,
    }),
  );
  await bot.onTrade(
    trade({
      mint: "4313WPjwvWAMrpo1oWrW7BXGWS2nXbqj47nbMFSDpump",
      priceSol: 1574.2135076795605 / 1e9,
      signature: "bad",
    }),
  );
  const rejected = (log as ListLogger).entries.find((entry) => entry.message === "mark_rejected");
  assert.ok(rejected);
  now += 135_000;
  await bot.checkHolds();
  const quote = sells[0]?.quotePriceSol ?? 0;
  assert.ok(quote > 0);
  assert.ok(quote < 1e-7);
  assert.equal(sells[0]?.reason, "volume_stall");
});
