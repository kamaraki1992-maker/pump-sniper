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

test("metadata retries later gateways, then caches only a loaded result", async () => {
  let now = 0;
  const urls: string[] = [];
  const flaky: typeof fetch = async (url) => {
    urls.push(String(url));
    if (urls.length < 3) return new Response("missing", { status: 404 });
    return new Response(JSON.stringify({ twitter: "https://x.com/alpha" }), { status: 200 });
  };
  const retried = new MetadataSocials({
    fetchImpl: flaky,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    backoffMs: 400,
    attemptTimeoutMs: 1_200,
  });
  const hit = await retried.lookup("ipfs://QmCID123/meta.json", { deadlineAtMs: 10_000 });
  assert.equal(hit.ok, true);
  assert.equal(hit.attempts, 3);
  assert.equal(hit.gateway, "dweb.link");
  assert.ok((hit.latencyMs ?? 0) >= 800);
  assert.equal(urls[1], "https://ipfs.io/ipfs/QmCID123/meta.json");
  assert.equal(urls[2], "https://dweb.link/ipfs/QmCID123/meta.json");
  const again = await retried.lookup("ipfs://QmCID123/meta.json", { deadlineAtMs: now + 10_000 });
  assert.equal(again.twitter, "https://x.com/alpha");
  assert.equal(urls.length, 3);

  now = 0;
  let secondAttempt = 0;
  const second: typeof fetch = async () => {
    secondAttempt += 1;
    if (secondAttempt === 1) return new Response("missing", { status: 503 });
    return new Response(JSON.stringify({ extensions: { x: "https://x.com/beta" } }), { status: 200 });
  };
  const onSecond = new MetadataSocials({
    fetchImpl: second,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    backoffMs: 300,
    attemptTimeoutMs: 1_200,
  });
  const later = await onSecond.lookup("https://example.test/meta.json", { deadlineAtMs: 5_000 });
  assert.equal(later.ok, true);
  assert.equal(later.attempts, 2);
  assert.equal(later.gateway, "example.test");
});

test("a metadata deadline fails closed and is not cached", async () => {
  let now = 0;
  let calls = 0;
  const missing: typeof fetch = async () => {
    calls += 1;
    return new Response("no", { status: 404 });
  };
  const timed = new MetadataSocials({
    fetchImpl: missing,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    backoffMs: 400,
    attemptTimeoutMs: 1_200,
  });
  const missed = await timed.lookup("https://example.test/meta.json", { deadlineAtMs: 900 });
  assert.equal(missed.ok, false);
  assert.equal(missed.reason, "metadata_unavailable");
  assert.ok((missed.attempts ?? 0) >= 2);
  assert.equal(missed.gateway, null);
  const after = calls;
  now += 10;
  const again = await timed.lookup("https://example.test/meta.json", { deadlineAtMs: now + 900 });
  assert.equal(again.reason, "metadata_unavailable");
  assert.ok(calls > after);
});

test("no_socials is final and is not retried", async () => {
  let now = 0;
  let calls = 0;
  const empty: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ website: "https://x.com/ignored" }), { status: 200 });
  };
  const socials = new MetadataSocials({
    fetchImpl: empty,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    backoffMs: 400,
    attemptTimeoutMs: 1_200,
  });
  const decision = await socials.lookup("https://example.test/meta.json", { deadlineAtMs: 10_000 });
  assert.equal(decision.reason, "no_socials");
  assert.equal(decision.attempts, 1);
  assert.equal(calls, 1);
  now += 50;
  const cached = await socials.lookup("https://example.test/meta.json", { deadlineAtMs: now + 10_000 });
  assert.equal(cached.reason, "no_socials");
  assert.equal(calls, 1);
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
  const logged = lines.join("\n");
  assert.match(logged, /no_socials/);
  assert.match(logged, /"latency_ms":/);
  assert.match(logged, /"attempts":1/);
});

test("a watch keeps retrying metadata and logs the attempt that answered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "socials-retry-"));
  const config = loadConfig({ DATA_DIR: dir, REQUIRE_SOCIALS: "true" });
  config.dataDir = dir;
  config.tradesPath = join(dir, "trades.jsonl");
  config.positionsPath = join(dir, "positions.json");
  config.entryWatchMinSec = 0;
  config.entryWatchMaxSec = 5;
  let now = Date.parse("2026-11-10T12:00:00.000Z");
  const started = now;
  let fetches = 0;
  const lines: string[] = [];
  const log = new Logger();
  log.info = (message, fields) => {
    lines.push(JSON.stringify({ message, fields }));
  };
  const bot = new SniperBot({
    config,
    executor: {
      buy: async () => {
        throw new Error("no buy");
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
    solQuote: () => ({ usd: 100, updatedAtMs: started }),
    now: () => new Date(now),
    sleep: async (ms) => {
      now += ms;
    },
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
    metadataSocials: new MetadataSocials({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      backoffMs: 100,
      attemptTimeoutMs: 1_200,
      fetchImpl: async () => {
        fetches += 1;
        if (fetches < 2) return new Response("missing", { status: 404 });
        return new Response(JSON.stringify({ twitter: "https://x.com/alpha" }), { status: 200 });
      },
    }),
  });
  const launch: MarketLaunch = {
    kind: "launch",
    mint: "MintRetry",
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
  const logged = lines.join("\n");
  assert.equal(fetches, 2);
  assert.match(logged, /"attempts":2/);
  assert.match(logged, /"latency_ms":/);
  assert.match(logged, /example\.test/);
  assert.doesNotMatch(logged, /metadata_unavailable/);
  assert.ok(now - started <= 5_000 + METADATA_OVERSHOOT_MS);
});

const METADATA_OVERSHOOT_MS = 400;
