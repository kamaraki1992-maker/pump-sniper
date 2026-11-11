import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SniperBot } from "../src/bot.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { confidenceBreakdown } from "../src/confidence.js";
import { Logger } from "../src/logger.js";
import { TOTAL_SUPPLY_TOKENS } from "../src/pricing.js";
import { PositionBook } from "../src/positions.js";
import { TradeLog } from "../src/report.js";
import type { FillResult, MarketLaunch, MarketTrade } from "../src/types.js";

const QUOTE_AT = Date.parse("2026-11-10T12:00:00.000Z");
const INITIAL_BUY = 1_000_000;

function entryScore(buys: number, sells = 0): number {
  const holdPct = (INITIAL_BUY / TOTAL_SUPPLY_TOKENS) * 100;
  return confidenceBreakdown({ holdPct, buys, sells, safetyOk: true }).score * 100;
}

function launch(mint: string): MarketLaunch {
  return {
    kind: "launch",
    mint,
    name: "N",
    symbol: "S",
    creator: "Creator",
    signature: `create-${mint}`,
    initialBuyTokens: INITIAL_BUY,
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

function trade(mint: string, at: number, wallet: string, sol: number): MarketTrade {
  return {
    kind: "trade",
    mint,
    txType: "buy",
    trader: wallet,
    signature: `${mint}-${at}`,
    solQuoted: true,
    priceSol: 1.2,
    marketCapSol: 36,
    vSolSol: 30,
    vTokens: 1_073_000_000,
    solAmount: sol,
    slot: 2,
  };
}

function makeBot(dir: string, minEntryScore: string | undefined, lines: string[]) {
  const env: Record<string, string> = { DATA_DIR: dir };
  if (minEntryScore !== undefined) env.MIN_ENTRY_SCORE = minEntryScore;
  const config = loadConfig(env);
  config.entryWatchMaxSec = 0;
  config.earlyExitWindowSec = 0;
  const log = new Logger();
  log.info = (message, fields) => {
    lines.push(JSON.stringify({ message, ...fields }));
  };
  let buys = 0;
  const trades = new TradeLog(join(dir, "trades.jsonl"));
  const bot = new SniperBot({
    config,
    executor: {
      buy: async () => {
        buys += 1;
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
      sell: async () => {
        throw new Error("no sell");
      },
    },
    history: { lookup: async () => ({ ok: true }) },
    positions: new PositionBook(join(dir, "positions.json")),
    trades,
    log,
    solUsd: () => 100,
    solQuote: () => ({ usd: 100, updatedAtMs: QUOTE_AT }),
    now: () => new Date(QUOTE_AT),
    sleep: async () => {},
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
  });
  return { bot, trades, buys: () => buys, config };
}

test("MIN_ENTRY_SCORE blocks below the threshold, passes at it, and stays off when unset", async () => {
  assert.throws(() => loadConfig({ MIN_ENTRY_SCORE: "0" }), ConfigError);
  assert.throws(() => loadConfig({ MIN_ENTRY_SCORE: "101" }), ConfigError);

  const quiet = entryScore(0);
  const blockedDir = mkdtempSync(join(tmpdir(), "score-block-"));
  const blockedLines: string[] = [];
  const blocked = makeBot(blockedDir, "90", blockedLines);
  await blocked.bot.onLaunch(launch("Low"));
  assert.equal(blocked.buys(), 0);
  const skipped = blockedLines.join("\n");
  assert.match(skipped, /entry_low_score/);
  assert.match(skipped, /"hold":/);
  assert.match(skipped, /"flow":/);
  assert.match(skipped, /"raw":/);
  assert.match(skipped, /"score":/);

  const exactDir = mkdtempSync(join(tmpdir(), "score-exact-"));
  const exactLines: string[] = [];
  const exact = makeBot(exactDir, "90", exactLines);
  exact.config.minEntryScore = quiet;
  await exact.bot.onLaunch(launch("Exact"));
  assert.equal(exact.buys(), 1);
  assert.equal(exact.trades.readAll().find((row) => row.side === "buy")?.entryScore, quiet);
  assert.match(exactLines.join("\n"), /"entryScore":/);

  const openDir = mkdtempSync(join(tmpdir(), "score-off-"));
  const openLines: string[] = [];
  const open = makeBot(openDir, undefined, openLines);
  await open.bot.onLaunch(launch("Open"));
  assert.equal(open.buys(), 1);
  assert.ok((open.trades.readAll().find((row) => row.side === "buy")?.entryScore ?? 0) > 0);
  assert.match(openLines.join("\n"), /"entryScore":/);
});

test("the score gate applies to the early and full entry stages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "score-early-"));
  const config = loadConfig({
    DATA_DIR: dir,
    MIN_ENTRY_SCORE: "99",
    ENTRY_WATCH_MIN_SEC: "5",
    ENTRY_WATCH_MAX_SEC: "5",
    ENTRY_EARLY_SEC: "3",
    ENTRY_EARLY_MIN_NET_BUY_SOL: "1.2",
    ENTRY_MIN_NET_BUY_SOL: "1.5",
    ENTRY_MIN_BUYS: "4",
    ENTRY_MIN_UNIQUE_BUYERS: "3",
  });
  config.earlyExitWindowSec = 0;
  config.devSellExit = false;
  let now = 0;
  const lines: string[] = [];
  const log = new Logger();
  log.info = (message, fields) => {
    lines.push(JSON.stringify({ message, ...fields }));
  };
  let bought = 0;
  const prints = [
    { at: 400, wallet: "a", sol: 0.35 },
    { at: 1_400, wallet: "b", sol: 0.35 },
    { at: 2_400, wallet: "c", sol: 0.35 },
    { at: 2_700, wallet: "d", sol: 0.35 },
  ];
  const bot = new SniperBot({
    config,
    executor: {
      buy: async () => {
        bought += 1;
        const fill: FillResult = {
          status: "filled",
          signature: "paper",
          solscan: null,
          price: 1,
          sizeSol: 0.03,
          tokenAmount: 1,
          feesSol: 0,
          jitoTipSol: 0,
          cashflowSol: 0.03,
          error: null,
        };
        return fill;
      },
      sell: async () => {
        throw new Error("no sell");
      },
    },
    history: { lookup: async () => ({ ok: true }) },
    positions: new PositionBook(join(dir, "positions.json")),
    trades: new TradeLog(join(dir, "trades.jsonl")),
    log,
    solUsd: () => 100,
    solQuote: () => ({ usd: 100, updatedAtMs: QUOTE_AT }),
    now: () => new Date(now),
    sleep: async (ms) => {
      const next = now + ms;
      for (const row of prints) {
        if (row.at > now && row.at <= next) {
          now = row.at;
          await bot.onTrade(trade("Early", row.at, row.wallet, row.sol));
        }
      }
      now = next;
    },
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
  });
  await bot.onLaunch(launch("Early"));
  assert.equal(bought, 0);
  assert.ok(now < 5_000);
  assert.match(lines.join("\n"), /entry_low_score/);

  const fullDir = mkdtempSync(join(tmpdir(), "score-full-"));
  const fullConfig = loadConfig({
    DATA_DIR: fullDir,
    MIN_ENTRY_SCORE: "99",
    ENTRY_WATCH_MIN_SEC: "5",
    ENTRY_WATCH_MAX_SEC: "5",
    ENTRY_EARLY_SEC: "3",
    ENTRY_EARLY_MIN_NET_BUY_SOL: "1.2",
    ENTRY_MIN_NET_BUY_SOL: "0.1",
    ENTRY_MIN_BUYS: "4",
    ENTRY_MIN_UNIQUE_BUYERS: "3",
  });
  fullConfig.earlyExitWindowSec = 0;
  fullConfig.devSellExit = false;
  now = 0;
  const fullLines: string[] = [];
  const fullLog = new Logger();
  fullLog.info = (message, fields) => {
    fullLines.push(JSON.stringify({ message, ...fields }));
  };
  const thin = [
    { at: 400, wallet: "a", sol: 0.05 },
    { at: 1_400, wallet: "b", sol: 0.05 },
    { at: 2_400, wallet: "c", sol: 0.05 },
    { at: 2_700, wallet: "d", sol: 0.05 },
  ];
  const full = new SniperBot({
    config: fullConfig,
    executor: {
      buy: async () => {
        throw new Error("no buy");
      },
      sell: async () => {
        throw new Error("no sell");
      },
    },
    history: { lookup: async () => ({ ok: true }) },
    positions: new PositionBook(join(fullDir, "positions.json")),
    trades: new TradeLog(join(fullDir, "trades.jsonl")),
    log: fullLog,
    solUsd: () => 100,
    solQuote: () => ({ usd: 100, updatedAtMs: QUOTE_AT }),
    now: () => new Date(now),
    sleep: async (ms) => {
      const next = now + ms;
      for (const row of thin) {
        if (row.at > now && row.at <= next) {
          now = row.at;
          await full.onTrade(trade("Full", row.at, row.wallet, row.sol));
        }
      }
      now = next;
    },
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
  });
  await full.onLaunch(launch("Full"));
  assert.ok(now >= 5_000);
  assert.match(fullLines.join("\n"), /entry_low_score/);
});
