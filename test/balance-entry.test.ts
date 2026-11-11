import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SniperBot } from "../src/bot.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { PaperBalance } from "../src/paper-balance.js";
import { PositionBook } from "../src/positions.js";
import { TradeLog } from "../src/report.js";
import { MetadataSocials } from "../src/socials.js";
import type { FillResult, MarketLaunch, MarketTrade, OrderRequest, Position } from "../src/types.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");

function launch(mint: string, price = 1): MarketLaunch {
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
    priceSol: price,
    marketCapSol: 30,
    vSolSol: 30,
    vTokens: 1_073_000_000,
    bondingCurveKey: null,
    slot: 1,
    metadataUri: "https://example.test/meta.json",
  };
}

test("percent sizing follows paper capital, clamps at $30, and skips when cash is short", async () => {
  assert.throws(() => loadConfig({ BUY_SIZE_PCT_OF_BALANCE: "30", PAPER_START_BALANCE_SOL: "1" }), ConfigError);
  assert.throws(() => loadConfig({ BUY_SIZE_PCT_OF_BALANCE: "15" }), ConfigError);
  assert.throws(() => loadConfig({ ENTRY_EARLY_SEC: "3" }), ConfigError);

  const dir = mkdtempSync(join(tmpdir(), "pct-"));
  const config = loadConfig({
    DATA_DIR: dir,
    BUY_SIZE_SOL: "0.5",
    BUY_SIZE_PCT_OF_BALANCE: "10",
    PAPER_START_BALANCE_SOL: "1",
  });
  config.entryWatchMaxSec = 0;
  config.earlyExitWindowSec = 0;
  const paper = new PaperBalance(join(dir, "paper-balance.json"), config.paperStartBalanceSol ?? 0);
  const positions = new PositionBook(join(dir, "positions.json"));
  const orders: OrderRequest[] = [];
  const lines: string[] = [];
  const log = new Logger();
  log.info = (message, fields) => {
    lines.push(JSON.stringify({ message, ...fields }));
  };
  const bot = new SniperBot({
    config,
    executor: {
      buy: async (order) => {
        orders.push(order);
        const fill: FillResult = {
          status: "filled",
          signature: "paper",
          solscan: null,
          price: 1,
          sizeSol: order.sizeSol,
          tokenAmount: 1_000,
          feesSol: 0,
          jitoTipSol: 0,
          cashflowSol: order.sizeSol,
          error: null,
        };
        return fill;
      },
      sell: async () => {
        throw new Error("no sell");
      },
    },
    history: { lookup: async () => ({ ok: true }) },
    positions,
    trades: new TradeLog(join(dir, "trades.jsonl")),
    log,
    solUsd: () => 100,
    solQuote: () => ({ usd: 100, updatedAtMs: NOW }),
    now: () => new Date(NOW),
    sleep: async () => {},
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
    paperBalance: paper,
  });
  await bot.onLaunch(launch("Aaa"));
  assert.ok(Math.abs((orders[0]?.sizeSol ?? 0) - 0.1) < 1e-12);
  assert.match(lines.join("\n"), /"balanceSol":1/);
  assert.match(lines.join("\n"), /"pct":10/);
  assert.equal(new PaperBalance(join(dir, "paper-balance.json"), 99).cash(), 0.9);

  await bot.onLaunch(launch("Bbb"));
  assert.ok(Math.abs((orders[1]?.sizeSol ?? 0) - 0.1) < 1e-12);
  positions.close("Aaa");
  positions.close("Bbb");
  paper.add(0.7);
  await bot.onLaunch(launch("Ccc"));
  assert.ok(Math.abs((orders[2]?.sizeSol ?? 0) - 0.15) < 1e-12);

  const cappedDir = mkdtempSync(join(tmpdir(), "cap-"));
  const cappedConfig = loadConfig({
    DATA_DIR: cappedDir,
    BUY_SIZE_SOL: "0.01",
    BUY_SIZE_PCT_OF_BALANCE: "25",
    PAPER_START_BALANCE_SOL: "10",
  });
  cappedConfig.entryWatchMaxSec = 0;
  const cappedOrders: OrderRequest[] = [];
  const capped = new SniperBot({
    config: cappedConfig,
    executor: {
      buy: async (order) => {
        cappedOrders.push(order);
        return {
          status: "filled",
          signature: "paper",
          solscan: null,
          price: 1,
          sizeSol: order.sizeSol,
          tokenAmount: 1,
          feesSol: 0,
          jitoTipSol: 0,
          cashflowSol: order.sizeSol,
          error: null,
        };
      },
      sell: async () => {
        throw new Error("no sell");
      },
    },
    history: { lookup: async () => ({ ok: true }) },
    positions: new PositionBook(join(cappedDir, "positions.json")),
    trades: new TradeLog(join(cappedDir, "trades.jsonl")),
    log: new Logger(),
    solUsd: () => 20,
    solQuote: () => ({ usd: 20, updatedAtMs: NOW }),
    now: () => new Date(NOW),
    sleep: async () => {},
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
    paperBalance: new PaperBalance(join(cappedDir, "paper-balance.json"), 10),
  });
  await capped.onLaunch(launch("Cap"));
  assert.ok(Math.abs((cappedOrders[0]?.sizeSol ?? 0) - 1.5) < 1e-12);

  const shortDir = mkdtempSync(join(tmpdir(), "short-"));
  const shortConfig = loadConfig({
    DATA_DIR: shortDir,
    BUY_SIZE_PCT_OF_BALANCE: "15",
    PAPER_START_BALANCE_SOL: "1",
  });
  shortConfig.entryWatchMaxSec = 0;
  const shortPaper = new PaperBalance(join(shortDir, "paper-balance.json"), 1);
  shortPaper.add(0.01 - 1);
  const shortPositions = new PositionBook(join(shortDir, "positions.json"));
  const held: Position = {
    mint: "Held",
    name: "H",
    symbol: "H",
    creator: "Creator",
    tokenAmount: 1,
    entryPriceSol: 1,
    costSol: 2,
    feesSol: 0,
    tipSol: 0,
    openedAt: new Date(NOW).toISOString(),
    mode: "paper",
    entrySignature: "old",
    lastMarkPriceSol: 1,
  };
  shortPositions.open(held);
  const skips: string[] = [];
  const shortLog = new Logger();
  shortLog.info = (message, fields) => {
    skips.push(JSON.stringify({ message, ...fields }));
  };
  let bought = 0;
  const short = new SniperBot({
    config: shortConfig,
    executor: {
      buy: async () => {
        bought += 1;
        throw new Error("should not buy");
      },
      sell: async () => {
        throw new Error("no sell");
      },
    },
    history: { lookup: async () => ({ ok: true }) },
    positions: shortPositions,
    trades: new TradeLog(join(shortDir, "trades.jsonl")),
    log: shortLog,
    solUsd: () => 100,
    solQuote: () => ({ usd: 100, updatedAtMs: NOW }),
    now: () => new Date(NOW),
    sleep: async () => {},
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
    paperBalance: shortPaper,
  });
  await short.onLaunch(launch("Short"));
  assert.equal(bought, 0);
  assert.match(skips.join("\n"), /insufficient_balance/);
});

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

test("the early entry buys at 1.2 SOL by 3s, otherwise waits for 1.5 SOL at 5s", async () => {
  const dir = mkdtempSync(join(tmpdir(), "early-"));
  const config = loadConfig({
    DATA_DIR: dir,
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
      buy: async (order) => {
        bought += 1;
        return {
          status: "filled",
          signature: "paper",
          solscan: null,
          price: 1,
          sizeSol: order.sizeSol,
          tokenAmount: 1,
          feesSol: 0,
          jitoTipSol: 0,
          cashflowSol: order.sizeSol,
          error: null,
        };
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
    solQuote: () => ({ usd: 100, updatedAtMs: NOW }),
    now: () => new Date(now),
    sleep: async (ms) => {
      const next = now + ms;
      for (const print of prints) {
        if (print.at > now && print.at <= next) {
          now = print.at;
          await bot.onTrade(trade("Early", print.at, print.wallet, print.sol));
        }
      }
      now = next;
    },
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
  });
  await bot.onLaunch(launch("Early"));
  assert.equal(bought, 1);
  assert.ok(now < 5_000);
  assert.match(lines.join("\n"), /"entryStage":"early"/);

  const laterDir = mkdtempSync(join(tmpdir(), "full-"));
  const laterConfig = loadConfig({
    DATA_DIR: laterDir,
    ENTRY_WATCH_MIN_SEC: "5",
    ENTRY_WATCH_MAX_SEC: "5",
    ENTRY_EARLY_SEC: "3",
    ENTRY_EARLY_MIN_NET_BUY_SOL: "1.2",
    ENTRY_MIN_NET_BUY_SOL: "1.5",
    ENTRY_MIN_BUYS: "4",
    ENTRY_MIN_UNIQUE_BUYERS: "3",
  });
  laterConfig.earlyExitWindowSec = 0;
  laterConfig.devSellExit = false;
  now = 0;
  const laterLines: string[] = [];
  const laterLog = new Logger();
  laterLog.info = (message, fields) => {
    laterLines.push(JSON.stringify({ message, ...fields }));
  };
  let laterBuys = 0;
  const laterPrints = [
    { at: 400, wallet: "a", sol: 0.2 },
    { at: 1_400, wallet: "b", sol: 0.2 },
    { at: 2_400, wallet: "c", sol: 0.2 },
    { at: 2_700, wallet: "d", sol: 0.2 },
    { at: 4_000, wallet: "a", sol: 0.2 },
    { at: 4_200, wallet: "b", sol: 0.2 },
    { at: 4_500, wallet: "c", sol: 0.2 },
    { at: 4_800, wallet: "d", sol: 0.2 },
  ];
  const later = new SniperBot({
    config: laterConfig,
    executor: {
      buy: async (order) => {
        laterBuys += 1;
        return {
          status: "filled",
          signature: "paper",
          solscan: null,
          price: 1,
          sizeSol: order.sizeSol,
          tokenAmount: 1,
          feesSol: 0,
          jitoTipSol: 0,
          cashflowSol: order.sizeSol,
          error: null,
        };
      },
      sell: async () => {
        throw new Error("no sell");
      },
    },
    history: { lookup: async () => ({ ok: true }) },
    positions: new PositionBook(join(laterDir, "positions.json")),
    trades: new TradeLog(join(laterDir, "trades.jsonl")),
    log: laterLog,
    solUsd: () => 100,
    solQuote: () => ({ usd: 100, updatedAtMs: NOW }),
    now: () => new Date(now),
    sleep: async (ms) => {
      const next = now + ms;
      for (const print of laterPrints) {
        if (print.at > now && print.at <= next) {
          now = print.at;
          await later.onTrade(trade("Full", print.at, print.wallet, print.sol));
        }
      }
      now = next;
    },
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
  });
  await later.onLaunch(launch("Full"));
  assert.equal(laterBuys, 1);
  assert.ok(now >= 5_000);
  assert.match(laterLines.join("\n"), /"entryStage":"full"/);
  assert.doesNotMatch(laterLines.join("\n"), /"entryStage":"early"/);
});

test("an early entry does not fire before socials are verified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "social-early-"));
  const config = loadConfig({
    DATA_DIR: dir,
    REQUIRE_SOCIALS: "true",
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
  let release: () => void = () => {};
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
        return {
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
    solQuote: () => ({ usd: 100, updatedAtMs: NOW }),
    now: () => new Date(now),
    sleep: async (ms) => {
      const next = now + ms;
      for (const print of prints) {
        if (print.at > now && print.at <= next) {
          now = print.at;
          await bot.onTrade(trade("Wait", print.at, print.wallet, print.sol));
        }
      }
      now = next;
      if (now >= 3_200) release();
    },
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
    metadataSocials: new MetadataSocials({
      retry: false,
      attemptTimeoutMs: 60_000,
      mode: "any",
      fetchImpl: () =>
        new Promise((resolve) => {
          release = () =>
            resolve(new Response(JSON.stringify({ twitter: "https://x.com/alpha" }), { status: 200 }));
        }),
    }),
  });
  await bot.onLaunch(launch("Wait"));
  assert.equal(bought, 0);
  assert.doesNotMatch(lines.join("\n"), /"entryStage":"early"/);
  assert.match(lines.join("\n"), /entry_low_volume/);
});
