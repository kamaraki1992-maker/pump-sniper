import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { PaperExecutor } from "../src/executor-paper.js";
import { Logger } from "../src/logger.js";
import type { ChainFacts } from "../src/momentum/chain.js";
import type { DexPair, MomentumMarket } from "../src/momentum/market.js";
import { PositionBook } from "../src/positions.js";
import { TradeLog } from "../src/report.js";
import { createScalpGate, type ScalpHint } from "../src/scalp/gate.js";
import { ScalpRunner } from "../src/scalp/runner.js";
import { scalpGate, scalpWarmInterest, type ScalpPrint } from "../src/scalp/rules.js";

const hint: ScalpHint = {
  ageMs: 2 * 60 * 1000,
  liquidityUsd: 20_000,
  bundlePct: 1,
  creator: "creator",
};

const chainOk: ChainFacts = { mintOk: true, mintReason: null, top10Pct: 10, devPct: 1 };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function config(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scalp-gate-"));
  return loadConfig({
    STRATEGY: "scalp",
    PAPER_START_BALANCE_SOL: "1",
    DATA_DIR: dir,
    KILL_FILE: join(dir, "KILL"),
    ...extra,
  });
}

function pair(): DexPair {
  return {
    mint: "Mint",
    pairAddress: "Pair",
    dexId: "pumpfun",
    symbol: "A",
    name: "A",
    priceUsd: 1,
    marketCapUsd: 100_000,
    liquidityUsd: 20_000,
    volume5mUsd: 0,
    volume1hUsd: null,
    buys5m: 0,
    sells5m: 0,
    priceChange5mPct: null,
    pairCreatedAtMs: null,
    baseAmount: null,
    quoteAmount: null,
    quoteMint: null,
    socialsOk: true,
  };
}

function market(waitMs = 0): MomentumMarket {
  return {
    async candidates() { return []; },
    async pair() {
      if (waitMs > 0) await delay(waitMs);
      return pair();
    },
    async candles() { return []; },
    async trades() { return null; },
  };
}

test("a cached prewarmed sim passes the gate quickly", async () => {
  let calls = 0;
  let release: (result: { ok: boolean; reason: string | null }) => void = () => {};
  const notes: Array<Record<string, unknown>> = [];
  const gate = createScalpGate(config(), market(), {
    log: { info(_message, fields) { notes.push({ ...fields }); } },
    chain: async () => chainOk,
    honeypot: () => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  gate.prewarm("MintWarm", hint);
  assert.equal(calls, 1);
  release({ ok: true, reason: null });
  await delay(20);
  const started = Date.now();
  const facts = await gate.check("MintWarm", hint);
  assert.ok(Date.now() - started < 50);
  assert.notEqual(facts, "timeout");
  if (facts === "timeout") return;
  assert.equal(facts.honeypotOk, true);
  assert.equal(scalpGate(facts).ok, true);
  assert.equal(calls, 1);
  assert.equal(notes.some((row) => row.cacheHit === true && typeof row.simMs === "number"), true);
});

test("a sim that times out still blocks", async () => {
  const gate = createScalpGate(config({ SCALP_SIM_TIMEOUT_MS: "250", SCALP_GATE_MS: "2000" }), market(), {
    chain: async () => chainOk,
    honeypot: () => new Promise(() => {}),
  });
  const facts = await Promise.race([
    gate.check("MintSlow", hint),
    delay(800).then(() => "hung" as const),
  ]);
  assert.notEqual(facts, "hung");
  assert.notEqual(facts, "timeout");
  if (facts === "hung" || facts === "timeout") return;
  assert.equal(facts.honeypotOk, false);
  assert.equal(facts.honeypotReason, "honeypot_unsimulated");
  assert.equal(scalpGate(facts).reason, "honeypot_unsimulated");
});

test("a sim that reports unsellable still blocks", async () => {
  const gate = createScalpGate(config(), market(), {
    chain: async () => chainOk,
    honeypot: async () => ({ ok: false, reason: "honeypot" }),
  });
  const facts = await gate.check("MintTrap", hint);
  assert.notEqual(facts, "timeout");
  if (facts === "timeout") return;
  assert.equal(facts.honeypotOk, false);
  assert.equal(scalpGate(facts).reason, "honeypot");
});

test("parallel safety checks honor their own timeout", async () => {
  const workMs = 80;
  const startedAt: number[] = [];
  const gate = createScalpGate(config({ SCALP_GATE_MS: "2000", SCALP_SIM_TIMEOUT_MS: "2000" }), market(workMs), {
    chain: async () => {
      startedAt.push(Date.now());
      await delay(workMs);
      return chainOk;
    },
    honeypot: async () => {
      startedAt.push(Date.now());
      await delay(workMs);
      return { ok: true, reason: null };
    },
  });
  const started = Date.now();
  const facts = await gate.check("MintParallel", hint);
  const elapsed = Date.now() - started;
  assert.notEqual(facts, "timeout");
  assert.ok(elapsed < workMs * 2.5, `parallel checks took ${elapsed}ms`);
  assert.ok(Math.max(...startedAt) - Math.min(...startedAt) < workMs);

  const cut = createScalpGate(config({ SCALP_GATE_MS: "250", SCALP_SIM_TIMEOUT_MS: "2000" }), market(), {
    chain: () => new Promise(() => chainOk),
    honeypot: async () => ({ ok: true, reason: null }),
  });
  const hung = await Promise.race([
    cut.check("MintCut", hint),
    delay(800).then(() => "hung" as const),
  ]);
  assert.equal(hung, "timeout");
});

test("a 6% rise or one large buy is enough to prewarm", async () => {
  const now = 2_000_000;
  const print = (priceSol: number, solAmount: number): ScalpPrint => ({ atMs: now, priceSol, side: "buy", solAmount });
  const bars = { windowMs: 120_000, minUsd: 300, minSol: 2, solUsd: 100 };
  assert.equal(scalpWarmInterest([print(1, 0.1), print(1.05, 0.1)], now, bars), false);
  assert.equal(scalpWarmInterest([print(1, 0.1), print(1.06, 0.1)], now, bars), true);
  assert.equal(scalpWarmInterest([print(1, 2)], now, bars), true);

  const dir = mkdtempSync(join(tmpdir(), "scalp-warm-"));
  const warmed: string[] = [];
  const runner = new ScalpRunner({
    config: config(),
    executor: new PaperExecutor(config().paper),
    positions: new PositionBook(join(dir, "positions.json")),
    trades: new TradeLog(join(dir, "trades.jsonl")),
    log: new Logger(),
    solUsd: () => 100,
    now: () => new Date(now),
    market: market(),
    gate: async () => ({
      ageMs: 120_000,
      liquidityUsd: 20_000,
      mintOk: true,
      mintReason: null,
      honeypotOk: true,
      honeypotReason: null,
      top10Pct: 10,
      devPct: 1,
      bundlePct: 1,
      socialsOk: true,
    }),
    prewarm: (mint) => warmed.push(mint),
  });
  const mint = "MintWarm111";
  runner.watch(mint);
  runner.noteTrade({
    kind: "trade",
    mint,
    txType: "buy",
    trader: "buyer",
    signature: "a",
    solQuoted: true,
    priceSol: 1,
    marketCapSol: 400,
    vSolSol: 400,
    vTokens: 1_000_000,
    solAmount: 0.1,
  });
  runner.noteTrade({
    kind: "trade",
    mint,
    txType: "buy",
    trader: "buyer",
    signature: "b",
    solQuoted: true,
    priceSol: 1.06,
    marketCapSol: 400,
    vSolSol: 400,
    vTokens: 1_000_000,
    solAmount: 0.1,
  });
  await delay(20);
  assert.deepEqual(warmed, [mint]);
  assert.equal(runner["deps"].positions.get(mint), undefined);
});
