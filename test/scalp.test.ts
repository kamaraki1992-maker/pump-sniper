import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { eventsFromLogs, PUMP_SWAP_BUY_DISC, PUMP_SWAP_CREATE_DISC } from "../src/helius-logs.js";
import { PaperExecutor } from "../src/executor-paper.js";
import { Logger } from "../src/logger.js";
import { PaperBalance } from "../src/paper-balance.js";
import { PositionBook } from "../src/positions.js";
import { TradeLog } from "../src/report.js";
import { ScalpRunner } from "../src/scalp/runner.js";
import { SCALP, scalpExit, scalpGate, scalpSpike, type ScalpPrint } from "../src/scalp/rules.js";
import type { MarketTrade } from "../src/types.js";
import { WSOL_MINT } from "../src/pricing.js";

function prints(prices: number[], sides: Array<"buy" | "sell">, at = 1_000_000): ScalpPrint[] {
  return prices.map((priceSol, index) => ({ atMs: at + index, priceSol, side: sides[index] ?? "buy" }));
}

test("a 60-second spike needs a 12% to 25% rise and ten buys in a row", () => {
  const now = 2_000_000;
  const quiet = prints(Array.from({ length: 10 }, () => 1), Array(10).fill("buy"), now);
  assert.equal(scalpSpike(quiet, now).reason, "spike_history");
  const flat = prints(Array.from({ length: 10 }, () => 1), Array(10).fill("buy"), now - 1000);
  assert.equal(scalpSpike(flat, now).reason, "spike");
  const hot = [1, 1.02, 1.04, 1.06, 1.08, 1.1, 1.12, 1.13, 1.14, 1.15];
  const spike = scalpSpike(prints(hot, Array(10).fill("buy"), now - 1000), now);
  assert.equal(spike.ok, true);
  assert.ok((spike.risePct ?? 0) >= 12 && (spike.risePct ?? 0) <= 25);
  const fomo = scalpSpike(prints([1, ...Array(9).fill(1.3)], Array(10).fill("buy"), now - 1000), now);
  assert.equal(fomo.reason, "fomo");
  const broken = prints([1, 1.02, 1.04, 1.06, 1.08, 1.1, 1.12, 1.13, 1.14, 1.2], Array(10).fill("buy"), now - 1000);
  broken[4] = { ...broken[4]!, side: "sell" };
  assert.equal(scalpSpike(broken, now).reason, "consecutive_buys");
  const oldLow = [
    { atMs: now - 120_000, priceSol: 1, side: "buy" as const },
    ...prints(Array(10).fill(1.05), Array(10).fill("buy"), now - 1000),
  ];
  assert.equal(scalpSpike(oldLow, now).ok, false);
});

test("scalp exits ratchet the stop, sell 60%, trail 10%, and honor both clocks", () => {
  const held = {
    entryPriceSol: 1,
    peakPriceSol: 1,
    priceSol: 1,
    tpTaken: false,
    openedAtMs: 0,
    nowMs: 1_000,
    maxHoldMs: 30 * 60 * 1000,
  };
  assert.equal(scalpExit({ ...held, priceSol: 0.88 })?.reason, "scalp_sl");
  assert.equal(scalpExit({ ...held, priceSol: 0.89 }), null);
  assert.equal(scalpExit({ ...held, peakPriceSol: 1.12, priceSol: 1.12 }), null);
  assert.equal(scalpExit({ ...held, peakPriceSol: 1.18, priceSol: 1.18 })?.sellFraction, 0.6);
  assert.equal(scalpExit({ ...held, peakPriceSol: 1.2, priceSol: 1.03 })?.reason, "scalp_sl");
  assert.equal(scalpExit({ ...held, tpTaken: true, peakPriceSol: 1.2, priceSol: 1.08 })?.reason, "scalp_trail");
  assert.equal(scalpExit({ ...held, tpTaken: true, peakPriceSol: 1.2, priceSol: 1.09 }), null);
  assert.equal(scalpExit({ ...held, peakPriceSol: 1.09, priceSol: 1.05, nowMs: SCALP.fastHoldMs })?.reason, "scalp_fast");
  assert.equal(scalpExit({ ...held, peakPriceSol: 1.1, priceSol: 1.1, nowMs: SCALP.fastHoldMs }), null);
  assert.equal(scalpExit({ ...held, tpTaken: true, peakPriceSol: 1.2, priceSol: 1.15, nowMs: held.maxHoldMs })?.reason, "scalp_max_hold");
});

test("the safety gate fails closed and a paper spike buys at the fixed priority fee", async () => {
  assert.equal(scalpGate({
    ageMs: 2 * 60 * 1000,
    liquidityUsd: 12_000,
    mintOk: true,
    mintReason: null,
    honeypotOk: true,
    honeypotReason: null,
    top10Pct: 10,
    devPct: 1,
    bundlePct: 2,
    socialsOk: true,
  }).ok, true);
  assert.equal(scalpGate({
    ageMs: 30 * 1000,
    liquidityUsd: 12_000,
    mintOk: true,
    mintReason: null,
    honeypotOk: false,
    honeypotReason: "honeypot",
    top10Pct: 10,
    devPct: 1,
    bundlePct: 2,
    socialsOk: true,
  }).reason, "too_young");
  const dir = mkdtempSync(join(tmpdir(), "scalp-"));
  const config = loadConfig({
    STRATEGY: "scalp",
    PAPER_START_BALANCE_SOL: "10",
    DATA_DIR: dir,
    KILL_FILE: join(dir, "KILL"),
  });
  assert.equal(config.scalpPriorityFeeSol, 0.0002);
  assert.equal(config.scalpMaxHoldMin, 30);
  assert.equal(config.maxOpenPositions, 4);
  const positions = new PositionBook(join(dir, "positions.json"));
  const trades = new TradeLog(join(dir, "trades.jsonl"));
  let now = 1_700_000_000_000;
  const runner = new ScalpRunner({
    config,
    executor: new PaperExecutor(config.paper),
    positions,
    trades,
    log: new Logger(),
    solUsd: () => 100,
    now: () => new Date(now),
    market: {
      async candidates() { return []; },
      async pair() { return null; },
      async candles() { return []; },
      async trades() { return null; },
    },
    paperBalance: new PaperBalance(join(dir, "paper-balance.json"), 10),
    gate: async () => ({
      ageMs: 2 * 60 * 1000,
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
  });
  const mint = "MintScalp111";
  runner.noteTrade({
    kind: "trade",
    mint: "NotWatched",
    txType: "buy",
    trader: "buyer",
    signature: "ignored",
    solQuoted: true,
    priceSol: 2,
    marketCapSol: 400,
    vSolSol: 40,
    vTokens: 1_000_000,
  });
  runner.watch(mint);
  for (let i = 0; i < 10; i += 1) {
    const trade: MarketTrade = {
      kind: "trade",
      mint,
      txType: "buy",
      trader: "buyer",
      signature: `sig-${i}`,
      solQuoted: true,
      priceSol: 1 + i * 0.02,
      marketCapSol: 400,
      vSolSol: 40,
      vTokens: 1_000_000,
      solAmount: 0.1,
    };
    runner.noteTrade(trade);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const open = positions.get(mint);
  assert.equal(positions.get("NotWatched"), undefined);
  assert.equal(open?.strategy, "scalp");
  const buy = trades.readAll().at(-1);
  assert.equal(buy?.strategy, "scalp");
  assert.equal(buy?.costs?.priorityFeeSol, 0.0002);
  assert.equal(buy?.jitoTipSol, 0.0001);
  runner.noteTrade({
    kind: "trade",
    mint,
    txType: "sell",
    trader: "seller",
    signature: "stop",
    solQuoted: true,
    priceSol: open!.entryPriceSol * 0.8,
    marketCapSol: 300,
    vSolSol: 30,
    vTokens: 1_000_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(positions.get(mint), undefined);
  assert.equal(trades.readAll().at(-1)?.reason, "scalp_sl");
});

test("PumpSwap create-pool then buy becomes a priced trade", () => {
  const mint = Keypair.generate().publicKey;
  const quote = new PublicKey(WSOL_MINT);
  const pool = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const u64 = (value: bigint) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value);
    return buf;
  };
  const create = Buffer.concat([
    PUMP_SWAP_CREATE_DISC,
    u64(0n),
    Buffer.alloc(2),
    Keypair.generate().publicKey.toBuffer(),
    mint.toBuffer(),
    quote.toBuffer(),
    Buffer.from([6, 9]),
    u64(1n),
    u64(1n),
    u64(1_000_000_000n),
    u64(5_000_000_000n),
    u64(1n),
    u64(1n),
    u64(1n),
    Buffer.from([1]),
    pool.toBuffer(),
  ]);
  const buy = Buffer.concat([
    PUMP_SWAP_BUY_DISC,
    u64(0n),
    u64(1n),
    u64(1n),
    u64(1n),
    u64(1n),
    u64(2_000_000_000n),
    u64(10_000_000_000n),
    u64(1n),
    u64(1n),
    u64(1n),
    u64(1n),
    u64(1n),
    u64(1n),
    u64(1n),
    pool.toBuffer(),
    user.toBuffer(),
  ]);
  const map = new Map<string, { mint: string; quoteMint: string }>();
  const created = eventsFromLogs({ slot: 1, signature: "pool", err: null, logs: [`Program data: ${create.toString("base64")}`] }, map);
  assert.equal(created.events.length, 0);
  assert.equal(map.get(pool.toBase58())?.mint, mint.toBase58());
  const traded = eventsFromLogs({ slot: 2, signature: "swap", err: null, logs: [`Program data: ${buy.toString("base64")}`] }, map);
  const trade = traded.events.find((event) => event.kind === "trade");
  assert.equal(trade?.kind, "trade");
  if (trade?.kind !== "trade") return;
  assert.equal(trade.txType, "buy");
  assert.equal(trade.venue, "pumpswap");
  assert.equal(trade.mint, mint.toBase58());
  assert.ok((trade.priceSol ?? 0) > 0);
  assert.equal(quote.toBase58(), map.get(pool.toBase58())?.quoteMint);
  assert.equal(WSOL_MINT.length > 0, true);
});
