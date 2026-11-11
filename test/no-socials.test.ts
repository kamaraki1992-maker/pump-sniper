import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SniperBot } from "../src/bot.js";
import { ConfigError, loadConfig, type AppConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { PositionBook } from "../src/positions.js";
import { TradeLog } from "../src/report.js";
import { MetadataSocials } from "../src/socials.js";
import type { FillResult, MarketLaunch, MarketTrade, OrderRequest } from "../src/types.js";

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
    metadataUri: "https://example.test/meta.json",
  };
}

function print(mint: string, at: number, wallet: string, sol: number, price = 1.2): MarketTrade {
  return {
    kind: "trade",
    mint,
    txType: "buy",
    trader: wallet,
    signature: `${mint}-${at}`,
    solQuoted: true,
    priceSol: price,
    marketCapSol: 36,
    vSolSol: 30,
    vTokens: 1_073_000_000,
    solAmount: sol,
    slot: 2,
  };
}

function metadata(body: unknown): MetadataSocials {
  return new MetadataSocials({
    retry: false,
    attemptTimeoutMs: 60_000,
    mode: "any",
    fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
  });
}

function watchConfig(dir: string, extra: Record<string, string> = {}): AppConfig {
  const config = loadConfig({
    DATA_DIR: dir,
    REQUIRE_SOCIALS: "true",
    ALLOW_NO_SOCIALS_ENTRY: "true",
    NO_SOCIALS_TIME_STOP_SEC: "3",
    NO_SOCIALS_MIN_GAIN_PCT: "20",
    ENTRY_WATCH_MIN_SEC: "5",
    ENTRY_WATCH_MAX_SEC: "5",
    ENTRY_EARLY_SEC: "3",
    ENTRY_EARLY_MIN_NET_BUY_SOL: "1.2",
    ENTRY_MIN_NET_BUY_SOL: "1.5",
    ENTRY_MIN_BUYS: "4",
    ENTRY_MIN_UNIQUE_BUYERS: "3",
    ...extra,
  });
  config.earlyExitWindowSec = 0;
  config.devSellExit = false;
  config.volumeStallSec = 100_000;
  return config;
}

function botFor(input: {
  dir: string;
  mint: string;
  config: AppConfig;
  socials: unknown;
  now: { value: number };
  prints: Array<{ at: number; wallet: string; sol: number; price?: number }>;
  lines: string[];
  sells?: OrderRequest[];
}): { bot: SniperBot; positions: PositionBook; trades: TradeLog } {
  const log = new Logger();
  log.info = (message, fields) => {
    input.lines.push(JSON.stringify({ message, ...fields }));
  };
  const positions = new PositionBook(join(input.dir, "positions.json"));
  const trades = new TradeLog(join(input.dir, "trades.jsonl"));
  const bot = new SniperBot({
    config: input.config,
    executor: {
      buy: async (order) => {
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
      sell: async (order) => {
        input.sells?.push(order);
        return {
          status: "filled",
          signature: "paper",
          solscan: null,
          price: order.quotePriceSol,
          sizeSol: 0.03,
          tokenAmount: 1_000,
          feesSol: 0,
          jitoTipSol: order.tipSol ?? 0,
          cashflowSol: 0.03,
          error: null,
        };
      },
    },
    history: { lookup: async () => ({ ok: true }) },
    positions,
    trades,
    log,
    solUsd: () => 100,
    solQuote: () => ({ usd: 100, updatedAtMs: QUOTE_AT }),
    now: () => new Date(input.now.value),
    sleep: async (ms) => {
      const next = input.now.value + ms;
      for (const row of input.prints) {
        if (row.at > input.now.value && row.at <= next) {
          input.now.value = row.at;
          await bot.onTrade(print(input.mint, row.at, row.wallet, row.sol, row.price));
        }
      }
      input.now.value = next;
    },
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
    metadataSocials: metadata(input.socials),
  });
  return { bot, positions, trades };
}

const earlyPrints = [
  { at: 400, wallet: "a", sol: 0.35 },
  { at: 1_400, wallet: "b", sol: 0.35 },
  { at: 2_400, wallet: "c", sol: 0.35 },
  { at: 2_700, wallet: "d", sol: 0.35 },
];

const fullPrints = [
  ...earlyPrints.map((row) => ({ ...row, sol: 0.2 })),
  { at: 4_000, wallet: "a", sol: 0.2 },
  { at: 4_200, wallet: "b", sol: 0.2 },
  { at: 4_500, wallet: "c", sol: 0.2 },
  { at: 4_800, wallet: "d", sol: 0.2 },
];

test("no-socials config requires both time-stop keys above zero", () => {
  assert.throws(
    () => loadConfig({ ALLOW_NO_SOCIALS_ENTRY: "true" }),
    ConfigError,
  );
  assert.throws(
    () => loadConfig({ ALLOW_NO_SOCIALS_ENTRY: "true", NO_SOCIALS_TIME_STOP_SEC: "0", NO_SOCIALS_MIN_GAIN_PCT: "20" }),
    ConfigError,
  );
});

test("a no-socials token is bought on the early and full gates, and skipped below them", async () => {
  const none = { website: "https://example.test" };
  const earlyDir = mkdtempSync(join(tmpdir(), "ns-early-"));
  const earlyNow = { value: 0 };
  const earlyLines: string[] = [];
  const early = botFor({
    dir: earlyDir,
    mint: "EarlyNs",
    config: watchConfig(earlyDir),
    socials: none,
    now: earlyNow,
    prints: earlyPrints,
    lines: earlyLines,
  });
  await early.bot.onLaunch(launch("EarlyNs"));
  assert.equal(early.positions.get("EarlyNs")?.noSocials, true);
  assert.ok(earlyNow.value < 5_000);
  assert.equal(early.trades.readAll().find((row) => row.side === "buy")?.noSocials, true);
  assert.match(earlyLines.join("\n"), /"entryStage":"early"/);
  assert.match(earlyLines.join("\n"), /"noSocials":true/);
  early.positions.save(100, watchConfig(earlyDir).paper, new Date(QUOTE_AT).toISOString());
  const saved = JSON.parse(readFileSync(join(earlyDir, "positions.json"), "utf8")) as {
    positions: Array<{ noSocials?: boolean }>;
  };
  assert.equal(saved.positions[0]?.noSocials, true);

  const fullDir = mkdtempSync(join(tmpdir(), "ns-full-"));
  const fullNow = { value: 0 };
  const fullLines: string[] = [];
  const full = botFor({
    dir: fullDir,
    mint: "FullNs",
    config: watchConfig(fullDir),
    socials: none,
    now: fullNow,
    prints: fullPrints,
    lines: fullLines,
  });
  await full.bot.onLaunch(launch("FullNs"));
  assert.equal(full.positions.get("FullNs")?.noSocials, true);
  assert.ok(fullNow.value >= 5_000);
  assert.match(fullLines.join("\n"), /"entryStage":"full"/);
  assert.doesNotMatch(fullLines.join("\n"), /"entryStage":"early"/);

  const thinDir = mkdtempSync(join(tmpdir(), "ns-thin-"));
  const thinNow = { value: 0 };
  const thinLines: string[] = [];
  const thin = botFor({
    dir: thinDir,
    mint: "ThinNs",
    config: watchConfig(thinDir),
    socials: none,
    now: thinNow,
    prints: earlyPrints.map((row) => ({ ...row, sol: 0.1 })),
    lines: thinLines,
  });
  await thin.bot.onLaunch(launch("ThinNs"));
  assert.equal(thin.positions.list().length, 0);
  assert.match(thinLines.join("\n"), /entry_low_volume/);
  assert.doesNotMatch(thinLines.join("\n"), /"noSocials":true/);
});

test("the no-socials time stop sells below +20% and holds at +20%", async () => {
  const none = { website: "https://example.test" };
  const flatDir = mkdtempSync(join(tmpdir(), "ns-stop-"));
  const flatNow = { value: 0 };
  const sells: OrderRequest[] = [];
  const flat = botFor({
    dir: flatDir,
    mint: "FlatNs",
    config: watchConfig(flatDir),
    socials: none,
    now: flatNow,
    prints: earlyPrints,
    lines: [],
    sells,
  });
  await flat.bot.onLaunch(launch("FlatNs"));
  const opened = flatNow.value;
  flatNow.value = opened + 3_000;
  await flat.bot.checkHolds();
  assert.equal(flat.trades.readAll().find((row) => row.side === "sell")?.reason, "no_socials_time_stop");
  assert.equal(flat.trades.readAll().find((row) => row.side === "sell")?.noSocials, true);
  assert.equal(flat.positions.get("FlatNs"), undefined);
  assert.equal(sells[0]?.sellFraction, 1);

  const heldDir = mkdtempSync(join(tmpdir(), "ns-hold-"));
  const heldNow = { value: 0 };
  const heldConfig = watchConfig(heldDir);
  heldConfig.earlyExitWindowSec = 3;
  heldConfig.earlyExitMinGainPct = 50;
  const held = botFor({
    dir: heldDir,
    mint: "HeldNs",
    config: heldConfig,
    socials: none,
    now: heldNow,
    prints: earlyPrints,
    lines: [],
  });
  await held.bot.onLaunch(launch("HeldNs"));
  const boughtAt = heldNow.value;
  await held.bot.onTrade(print("HeldNs", boughtAt, "buyer", 0.1, 1.2));
  heldNow.value = boughtAt + 3_000;
  await held.bot.checkHolds();
  assert.equal(held.positions.get("HeldNs")?.noSocials, true);
  assert.equal(held.trades.readAll().some((row) => row.side === "sell"), false);
});

test("socials positions keep early_no_momentum, and the fast lane stays off by default", async () => {
  const socialDir = mkdtempSync(join(tmpdir(), "ns-social-"));
  const socialNow = { value: 0 };
  const socialConfig = watchConfig(socialDir);
  socialConfig.earlyExitWindowSec = 3;
  socialConfig.earlyExitMinGainPct = 10;
  const social = botFor({
    dir: socialDir,
    mint: "Social",
    config: socialConfig,
    socials: { twitter: "https://x.com/alpha" },
    now: socialNow,
    prints: earlyPrints,
    lines: [],
  });
  await social.bot.onLaunch(launch("Social"));
  assert.notEqual(social.positions.get("Social")?.noSocials, true);
  socialNow.value += 3_000;
  await social.bot.checkHolds();
  assert.equal(social.trades.readAll().find((row) => row.side === "sell")?.reason, "early_no_momentum");

  const offDir = mkdtempSync(join(tmpdir(), "ns-off-"));
  const offNow = { value: 0 };
  const offLines: string[] = [];
  const off = botFor({
    dir: offDir,
    mint: "OffNs",
    config: watchConfig(offDir, { ALLOW_NO_SOCIALS_ENTRY: "false" }),
    socials: { website: "https://example.test" },
    now: offNow,
    prints: earlyPrints,
    lines: offLines,
  });
  await off.bot.onLaunch(launch("OffNs"));
  assert.equal(off.positions.list().length, 0);
  assert.match(offLines.join("\n"), /no_socials/);
});
