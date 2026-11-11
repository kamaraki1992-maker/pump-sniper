import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SniperBot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { DailyLossBook } from "../src/daily-loss.js";
import { Logger } from "../src/logger.js";
import { PositionBook } from "../src/positions.js";
import { TradeLog } from "../src/report.js";
import type { FillResult, MarketLaunch } from "../src/types.js";

const DAY = "2026-11-10T21:30:00.000Z";
const NEXT = "2026-11-10T23:30:00.000Z";

class ListLogger extends Logger {
  readonly entries: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  override info(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ message, fields });
  }
}

function launch(mint: string): MarketLaunch {
  return {
    kind: "launch",
    mint,
    name: mint,
    symbol: "SYM",
    creator: "Creator",
    signature: mint,
    initialBuyTokens: 1_000_000,
    quoteMint: "So11111111111111111111111111111111111111112",
    solQuoted: true,
    priceSol: 1,
    marketCapSol: 30,
    vSolSol: 30,
    vTokens: 1_073_000_000,
    bondingCurveKey: null,
  };
}

function botFor(dir: string, nowIso: string, log: ListLogger) {
  const config = loadConfig({ DATA_DIR: dir, MAX_DAILY_LOSS_SOL: "0.25" });
  config.dataDir = dir;
  config.tradesPath = join(dir, "trades.jsonl");
  config.positionsPath = join(dir, "positions.json");
  config.stopFile = join(dir, "STOP");
  config.entryWatchMaxSec = 0;
  config.earlyExitWindowSec = 0;
  const positions = new PositionBook(config.positionsPath);
  const trades = new TradeLog(config.tradesPath);
  const bought: string[] = [];
  const fill = (cashflowSol: number): FillResult => ({
    status: "filled",
    signature: "paper",
    solscan: null,
    price: 1,
    sizeSol: cashflowSol,
    tokenAmount: 1_000,
    feesSol: 0,
    jitoTipSol: 0,
    cashflowSol,
    error: null,
  });
  const bot = new SniperBot({
    config,
    executor: {
      buy: async () => fill(0.5),
      sell: async (order) => fill(order.mint === "Loss" ? 0.25 : 0.5),
    },
    history: { lookup: async () => ({ ok: true }) },
    positions,
    trades,
    log,
    solUsd: () => 100,
    solQuote: () => ({ usd: 100, updatedAtMs: Date.parse(nowIso) }),
    now: () => new Date(nowIso),
    sleep: async () => {},
    subscribeMint: (mint) => bought.push(mint),
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
  });
  return { bot, positions, config, bought };
}

async function tradeDown(bot: SniperBot, mint: string): Promise<void> {
  await bot.onTrade({
    kind: "trade",
    mint,
    txType: "sell",
    trader: "x",
    signature: `${mint}-down`,
    solQuoted: true,
    priceSol: 0.5,
    marketCapSol: 15,
    vSolSol: 30,
    vTokens: 1_073_000_000,
  });
}

test("the daily stop trips at the threshold, blocks new buys, and still exits the open position", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daily-loss-"));
  const log = new ListLogger();
  const { bot, positions, config } = botFor(dir, DAY, log);
  await bot.onLaunch(launch("Loss"));
  await bot.onLaunch(launch("Hold"));
  assert.equal(positions.list().length, 2);
  await tradeDown(bot, "Loss");
  assert.equal(positions.list().length, 1);
  assert.equal(existsSync(config.stopFile), false);
  await bot.onLaunch(launch("Next"));
  assert.equal(positions.get("Next"), undefined);
  assert.equal(log.entries.some((entry) => entry.fields?.reason === "daily_stop"), true);
  await tradeDown(bot, "Hold");
  assert.equal(positions.list().length, 0);
  assert.equal(existsSync(config.stopFile), true);
  assert.match(readFileSync(config.stopFile, "utf8"), /daily_stop/);
  const pause = log.entries.find((entry) => entry.message === "daily_stop");
  assert.ok(pause);
  assert.equal(pause?.fields?.realizedSol, -0.25);

  const restarted = new ListLogger();
  const again = botFor(dir, DAY, restarted);
  await again.bot.onLaunch(launch("After"));
  assert.equal(again.positions.list().length, 0);
  assert.equal(restarted.entries.some((entry) => entry.fields?.reason === "daily_stop"), true);

  const rolled = new ListLogger();
  const nextDay = botFor(dir, NEXT, rolled);
  await nextDay.bot.onLaunch(launch("Tomorrow"));
  assert.equal(nextDay.positions.get("Tomorrow")?.mint, "Tomorrow");
});

test("paper and live daily pnl do not share a day, and a new Berlin day starts at zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "daily-book-"));
  const book = new DailyLossBook(join(dir, "daily-pnl.json"));
  assert.equal(book.add("paper", "2026-11-10", -0.25), -0.25);
  assert.equal(book.add("live", "2026-11-10", -0.01), -0.01);
  assert.equal(book.realized("paper", "2026-11-10"), -0.25);
  assert.equal(book.realized("live", "2026-11-10"), -0.01);
  assert.equal(book.realized("paper", "2026-11-11"), 0);
  const reloaded = new DailyLossBook(join(dir, "daily-pnl.json"));
  assert.equal(reloaded.realized("paper", "2026-11-10"), -0.25);
});
