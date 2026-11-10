import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SniperBot } from "../src/bot.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { INITIAL_CURVE_SPOT } from "../src/pricing.js";
import { PositionBook } from "../src/positions.js";
import { TradeLog } from "../src/report.js";
import type { FillResult, MarketLaunch, MarketTrade } from "../src/types.js";

const QUOTE_AT = Date.parse("2026-11-10T12:00:00.000Z");

function launch(mint: string): MarketLaunch {
  return {
    kind: "launch",
    mint,
    name: "N",
    symbol: "S",
    creator: "Creator",
    signature: `create-${mint}`,
    initialBuyTokens: 1_000_000,
    quoteMint: null,
    solQuoted: true,
    priceSol: 1,
    marketCapSol: 30,
    vSolSol: 30,
    vTokens: 1_073_000_000,
    bondingCurveKey: null,
    slot: 1,
  };
}

function trade(mint: string, signature: string, price: number): MarketTrade {
  return {
    kind: "trade",
    mint,
    txType: "sell",
    trader: "seller",
    signature,
    solQuoted: true,
    priceSol: price,
    marketCapSol: price * 1e9,
    vSolSol: null,
    vTokens: null,
    solAmount: 0.1,
    slot: 4,
  };
}

function makeBot(dir: string, env: Record<string, string>, now: { value: number }, lines: string[]) {
  const config: AppConfig = loadConfig({ DATA_DIR: dir, ...env });
  config.entryWatchMaxSec = 0;
  config.earlyExitWindowSec = 0;
  config.devSellExit = false;
  config.stopFastDropPct = 99;
  config.volumeStallSec = 100_000;
  const log = new Logger();
  log.info = (message, fields) => {
    lines.push(JSON.stringify({ message, ...fields }));
  };
  const positions = new PositionBook(join(dir, "positions.json"));
  const trades = new TradeLog(join(dir, "trades.jsonl"));
  const bot = new SniperBot({
    config,
    executor: {
      buy: async () => {
        const fill: FillResult = {
          status: "filled",
          signature: "paper",
          solscan: null,
          price: 1,
          sizeSol: 0.03,
          tokenAmount: 1_000,
          feesSol: 0,
          jitoTipSol: 0,
          cashflowSol: 0.03,
          error: null,
        };
        return fill;
      },
      sell: async (order) => ({
        status: "filled",
        signature: "paper",
        solscan: null,
        price: order.quotePriceSol,
        sizeSol: 0.02,
        tokenAmount: 1_000,
        feesSol: 0,
        jitoTipSol: order.tipSol ?? 0,
        cashflowSol: 0.02,
        error: null,
      }),
    },
    history: { lookup: async () => ({ ok: true }) },
    positions,
    trades,
    log,
    solUsd: () => 100,
    solQuote: () => ({ usd: 100, updatedAtMs: now.value }),
    now: () => new Date(now.value),
    sleep: async () => {},
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 31, vTokens: 1_040_000_000 }),
  });
  return { bot, positions, trades };
}

test("the post-buy guard ignores a sharp drop inside the window and a real drop still stops out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const now = { value: QUOTE_AT };
  const lines: string[] = [];
  const { bot, positions, trades } = makeBot(
    dir,
    { POST_BUY_GUARD_MS: "50", POST_BUY_GUARD_DROP_PCT: "20" },
    now,
    lines,
  );
  await bot.onLaunch(launch("Guard"));
  now.value += 10;
  await bot.onTrade(trade("Guard", "sharp", 0.7));
  assert.equal(positions.get("Guard") != null, true);
  assert.equal(trades.readAll().some((row) => row.side === "sell"), false);
  assert.match(lines.join("\n"), /stale_mark_ignored/);
  assert.match(lines.join("\n"), /post_buy/);

  now.value += 10;
  await bot.onTrade(trade("Guard", "exact", 0.8));
  assert.equal(trades.readAll().find((row) => row.side === "sell")?.reason, "sl");
});

test("a drop after the guard window still stops out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-later-"));
  const now = { value: QUOTE_AT };
  const { bot, trades } = makeBot(
    dir,
    { POST_BUY_GUARD_MS: "50", POST_BUY_GUARD_DROP_PCT: "20" },
    now,
    [],
  );
  await bot.onLaunch(launch("Later"));
  now.value += 60;
  await bot.onTrade(trade("Later", "real", 0.75));
  assert.equal(trades.readAll().find((row) => row.side === "sell")?.reason, "sl");
});

test("the initial-curve sentinel ignores that spot after the mint has traded above it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"));
  const now = { value: QUOTE_AT };
  const lines: string[] = [];
  const { bot, positions, trades } = makeBot(dir, {}, now, lines);
  await bot.onLaunch(launch("Curve"));
  now.value += 760;
  await bot.onTrade(trade("Curve", "stale", INITIAL_CURVE_SPOT));
  assert.equal(positions.get("Curve") != null, true);
  assert.equal(trades.readAll().some((row) => row.side === "sell"), false);
  assert.match(lines.join("\n"), /initial_curve/);

  now.value += 10;
  await bot.onTrade(trade("Curve", "real", 0.75));
  assert.equal(trades.readAll().find((row) => row.side === "sell")?.reason, "sl");
});

test("without the post-buy keys a sharp drop still exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noguard-"));
  const now = { value: QUOTE_AT };
  const { bot, trades } = makeBot(dir, {}, now, []);
  await bot.onLaunch(launch("Open"));
  now.value += 10;
  await bot.onTrade(trade("Open", "drop", 0.7));
  assert.equal(trades.readAll().find((row) => row.side === "sell")?.reason, "sl");
});
