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
import { MetadataSocials, metadataUrls, socialDecision, socialsFromMetadata } from "../src/socials.js";
import type { FillResult, MarketLaunch } from "../src/types.js";

test("twitter and telegram variants are accepted and website is ignored", () => {
  const hit = socialsFromMetadata({
    website: "https://x.com/not-counted",
    extensions: { twitter: "@pump_user", telegram: "https://t.me/pump_chat" },
  });
  assert.equal(hit.twitter, "@pump_user");
  assert.equal(hit.telegram, "https://t.me/pump_chat");
  assert.equal(socialDecision(hit, "any").ok, true);
  assert.equal(socialDecision({ twitter: hit.twitter, telegram: null }, "both").ok, false);
  assert.equal(socialDecision({ twitter: null, telegram: null }, "any").reason, "no_socials");
  assert.equal(socialsFromMetadata({ twitter: "https://twitter.com/hello", telegram: "not a link" }).telegram, null);
  assert.equal(socialsFromMetadata({ x: "https://x.com/hello" }).twitter, "https://x.com/hello");
  assert.equal(socialsFromMetadata({ twitter: "https://x.com/" }).twitter, null);
  assert.equal(socialsFromMetadata({ telegram: "https://telegram.me/room" }).telegram, "https://telegram.me/room");

  const urls = metadataUrls("ipfs://QmCID123/meta.json");
  assert.equal(urls[0], "ipfs://QmCID123/meta.json");
  assert.ok(urls.includes("https://ipfs.io/ipfs/QmCID123/meta.json"));
  assert.ok(urls.includes("https://dweb.link/ipfs/QmCID123/meta.json"));
  assert.ok(urls.includes("https://pump.mypinata.cloud/ipfs/QmCID123/meta.json"));
});

test("a metadata timeout fails closed and a result is cached", async () => {
  let now = 0;
  let calls = 0;
  const slow: typeof fetch = (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("slow")), 1_000);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
  };
  const timed = new MetadataSocials({ fetchImpl: slow, timeoutMs: 20, now: () => now });
  const missed = await timed.lookup("https://example.test/meta.json");
  assert.equal(missed.ok, false);
  assert.equal(missed.reason, "metadata_unavailable");
  const again = await timed.lookup("https://example.test/meta.json");
  assert.equal(again.reason, "metadata_unavailable");
  assert.equal(calls, 1);

  let fetched = 0;
  const ok: typeof fetch = async () => {
    fetched += 1;
    return new Response(JSON.stringify({ twitter: "https://x.com/alpha" }), { status: 200 });
  };
  const cached = new MetadataSocials({ fetchImpl: ok, now: () => now, cacheTtlMs: 1_000 });
  const first = await cached.lookup("ipfs://QmCache/meta.json");
  now += 10;
  const second = await cached.lookup("ipfs://QmCache/meta.json");
  assert.equal(first.ok, true);
  assert.equal(second.twitter, "https://x.com/alpha");
  assert.equal(fetched, 1);
});

test("a create without socials is skipped and does not buy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "socials-"));
  const config = loadConfig({ DATA_DIR: dir, REQUIRE_SOCIALS: "true", REQUIRE_SOCIALS_MODE: "any" });
  config.dataDir = dir;
  config.tradesPath = join(dir, "trades.jsonl");
  config.positionsPath = join(dir, "positions.json");
  config.entryWatchMaxSec = 0;
  const log = new Logger();
  const lines: string[] = [];
  log.info = (message, fields) => {
    lines.push(JSON.stringify({ message, fields }));
  };
  let bought = 0;
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
    positions: new PositionBook(config.positionsPath),
    trades: new TradeLog(config.tradesPath),
    log,
    solUsd: () => 100,
    solQuote: () => ({ usd: 100, updatedAtMs: Date.parse("2026-11-10T12:00:00.000Z") }),
    now: () => new Date("2026-11-10T12:00:00.000Z"),
    sleep: async () => {},
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
    metadataSocials: new MetadataSocials({
      mode: "any",
      fetchImpl: async () => new Response(JSON.stringify({ website: "https://example.test" }), { status: 200 }),
    }),
  });
  const launch: MarketLaunch = {
    kind: "launch",
    mint: "MintSocial",
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
    metadataUri: "https://example.test/meta.json",
  };
  await bot.onLaunch(launch);
  assert.equal(bought, 0);
  assert.match(lines.join("\n"), /no_socials/);
});
