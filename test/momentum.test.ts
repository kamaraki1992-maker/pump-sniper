import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";
import { PaperExecutor } from "../src/executor-paper.js";
import { Logger } from "../src/logger.js";
import { parseDexPair, parseGeckoCandles, parseGeckoTrades, parseSolanaMints } from "../src/momentum/market.js";
import { MomentumRunner } from "../src/momentum/runner.js";
import {
  MOMENTUM,
  bundledInsiderPct,
  evaluateMomentum,
  higherLows,
  localResistance,
  momentumExit,
  momentumSize,
  momentumSlippagePct,
  rsi,
  turboFees,
  type Candle,
  type MomentumFacts,
} from "../src/momentum/rules.js";
import { PaperBalance } from "../src/paper-balance.js";
import { PositionBook } from "../src/positions.js";
import { TradeLog } from "../src/report.js";
import type { MarketLaunch } from "../src/types.js";

const WIDTH = 5 * 60 * 1000;

function candles(closes: number[], lows: number[], start = 0): Candle[] {
  return closes.map((close, index) => ({
    ts: start + index * WIDTH,
    open: close,
    high: close + 0.2,
    low: lows[index] ?? close - 0.2,
    close,
    volume: 1,
  }));
}

function risingCloses(): { closes: number[]; lows: number[] } {
  const diffs = [1, -0.4, 1, -0.4, 1, -0.4, 1, -0.4, 1, -0.4, 1, -0.4, 1, -0.4];
  const closes = [100];
  for (const diff of diffs) closes.push(closes[closes.length - 1]! + diff);
  const lows = closes.map((close) => close - 0.2);
  lows[lows.length - 3] = 1;
  lows[lows.length - 2] = 2;
  lows[lows.length - 1] = 3;
  return { closes, lows };
}

function passingFacts(patch: Partial<MomentumFacts> = {}): MomentumFacts {
  const { closes, lows } = risingCloses();
  const series = candles(closes, lows);
  const nowMs = series.length * WIDTH;
  const resistance = localResistance(series, 6)!;
  return {
    nowMs,
    liquidityUsd: 20_000,
    dexId: "pumpswap",
    sawGraduation: false,
    top10Pct: 10,
    devPct: 1,
    bundlePct: 4,
    pairCreatedAtMs: nowMs - 30 * 60 * 1000,
    marketCapUsd: 100_000,
    volume5mUsd: 40_000,
    buys5m: 20,
    sells5m: 5,
    makers1h: 300,
    makersComplete: true,
    price: resistance + 1,
    candles: series,
    resistanceCandles: 6,
    mintOk: true,
    mintReason: null,
    sellVolume15mUsd: 1,
    buyVolume15mUsd: 10,
    volume15mComplete: true,
    ...patch,
  };
}

test("RSI is 100 on a rising series, 50 on equal swings, and null without a period", () => {
  const up = [10];
  for (let i = 0; i < 14; i += 1) up.push(up[up.length - 1]! + 1);
  assert.equal(rsi(up), 100);
  const flat = [10];
  for (let i = 0; i < 14; i += 1) flat.push(flat[flat.length - 1]! + (i % 2 === 0 ? 1 : -1));
  assert.equal(rsi(flat), 50);
  assert.equal(rsi([1, 2, 3]), null);
  const { closes } = risingCloses();
  const value = rsi(closes);
  assert.ok(value != null && value >= 55 && value <= 72, `rsi ${value}`);
});

test("each safety filter fails closed on its own", () => {
  assert.equal(evaluateMomentum(passingFacts()).action, "buy");
  const cases: Array<[Partial<MomentumFacts>, string]> = [
    [{ mintOk: false, mintReason: "mint-authority-set" }, "mint-authority-set"],
    [{ mintOk: false, mintReason: "freeze-authority-set" }, "freeze-authority-set"],
    [{ mintOk: false, mintReason: "transfer-fee" }, "transfer-fee"],
    [{ mintOk: false, mintReason: "transfer-hook" }, "transfer-hook"],
    [{ mintOk: false, mintReason: "unsupported-token-program" }, "unsupported-token-program"],
    [{ liquidityUsd: 14_999 }, "liquidity"],
    [{ dexId: "orca" }, "lp_not_canonical"],
    [{ dexId: "raydium", sawGraduation: false }, "lp_not_canonical"],
    [{ top10Pct: 22 }, "top10"],
    [{ top10Pct: null }, "top10_unavailable"],
    [{ devPct: 4 }, "dev_wallet"],
    [{ devPct: null }, "dev_unknown"],
    [{ bundlePct: 15 }, "bundle"],
    [{ bundlePct: null }, "bundle_unknown"],
    [{ pairCreatedAtMs: passingFacts().nowMs - 9 * 60 * 1000 }, "too_young"],
    [{ pairCreatedAtMs: passingFacts().nowMs - 24 * 60 * 60 * 1000 }, "too_old"],
    [{ pairCreatedAtMs: null }, "age_unknown"],
  ];
  for (const [patch, reason] of cases) {
    const decision = evaluateMomentum(passingFacts(patch));
    assert.equal(decision.action, "hold", reason);
    assert.equal(decision.reason, reason);
  }
  assert.equal(evaluateMomentum(passingFacts({ dexId: "raydium", sawGraduation: true })).action, "buy");
  assert.equal(
    evaluateMomentum(passingFacts({ pairCreatedAtMs: passingFacts().nowMs - MOMENTUM.minAgeMs })).action,
    "buy",
  );
});

test("each entry trigger fails on its own", () => {
  const base = passingFacts();
  assert.equal(higherLows(base.candles), true);
  assert.ok(base.price > (localResistance(base.candles, 6) ?? 0));
  const cases: Array<[Partial<MomentumFacts>, string]> = [
    [{ marketCapUsd: 49_999 }, "mcap"],
    [{ marketCapUsd: 400_001 }, "mcap"],
    [{ volume5mUsd: 20_000 * 1.5 - 1 }, "volume"],
    [{ buys5m: 18, sells5m: 10 }, "buy_sell_ratio"],
    [{ makers1h: 149 }, "makers"],
    [{ makers1h: null }, "makers_unavailable"],
    [{ makers1h: 10, makersComplete: false }, "makers_incomplete"],
    [{ price: localResistance(base.candles, 6)! }, "resistance"],
    [{ resistanceCandles: 6, candles: base.candles.slice(0, 4) }, "higher_lows"],
  ];
  for (const [patch, reason] of cases) {
    assert.equal(evaluateMomentum(passingFacts(patch)).reason, reason);
  }
  const flatLows = base.candles.map((candle, index) =>
    index >= base.candles.length - 3 ? { ...candle, low: 5 - index } : candle,
  );
  assert.equal(evaluateMomentum(passingFacts({ candles: flatLows })).reason, "higher_lows");
  const hot = passingFacts();
  hot.candles = hot.candles.map((candle, index) => ({
    ...candle,
    close: 10 + index,
    high: 11 + index,
    low: index + 1,
  }));
  hot.price = 10_000;
  assert.equal(evaluateMomentum(hot).reason, "rsi");
});

test("bundled insider supply counts non-creator buys in the create slot plus two", () => {
  const pct = bundledInsiderPct({
    supplyTokens: 1_000,
    createSlot: 10,
    creator: "dev",
    buys: [
      { slot: 10, trader: "dev", tokens: 500 },
      { slot: 10, trader: "a", tokens: 50 },
      { slot: 12, trader: "b", tokens: 40 },
      { slot: 13, trader: "c", tokens: 900 },
    ],
  });
  assert.equal(pct, 9);
  assert.equal(bundledInsiderPct({ supplyTokens: 1, createSlot: null, creator: "dev", buys: [] }), null);
});

test("sizing stays on 3% or 5% and keeps the $30 and 0.005 SOL caps", () => {
  const base = momentumSize({ balanceSol: 10, solUsd: 100, confidence: 50 });
  assert.equal(base.ok && base.pct, 3);
  assert.equal(base.ok && base.sizeUsd, 30);
  const high = momentumSize({ balanceSol: 10, solUsd: 100, confidence: 85.1 });
  assert.equal(high.ok && high.pct, 5);
  assert.equal(high.ok && high.sizeUsd, 30);
  const edge = momentumSize({ balanceSol: 1, solUsd: 200, confidence: 90 });
  assert.equal(edge.ok && edge.pct, 5);
  assert.equal(edge.ok && edge.sizeUsd, 10);
  assert.equal(edge.ok && edge.sizeSol, 0.05);
  const tiny = momentumSize({ balanceSol: 0.09, solUsd: 100, confidence: 90 });
  assert.equal(tiny.ok, false);
  if (!tiny.ok) assert.equal(tiny.reason, "buy_size_min");
  const at85 = momentumSize({ balanceSol: 1, solUsd: 200, confidence: 85 });
  assert.equal(at85.ok && at85.pct, 3);
});

test("exits fire in order and use fractions of the original position", () => {
  const held = {
    entryPriceSol: 1,
    peakPriceSol: 1,
    priceSol: 1,
    tp1Taken: false,
    tp2Taken: false,
    sellVolume15mUsd: 1,
    buyVolume15mUsd: 10,
    volume15mComplete: true,
  };
  assert.equal(momentumExit({ ...held, priceSol: 0.75 })?.reason, "momentum_sl");
  assert.equal(momentumExit({ ...held, priceSol: 0.75 })?.sellFraction, 1);
  assert.equal(momentumExit({ ...held, priceSol: 2, peakPriceSol: 2 })?.reason, "momentum_tp1");
  assert.equal(momentumExit({ ...held, priceSol: 5, peakPriceSol: 5 })?.reason, "momentum_tp1");
  assert.equal(momentumExit({ ...held, priceSol: 5, peakPriceSol: 5 })?.sellFraction, 0.5);
  const afterTp1 = momentumExit({ ...held, tp1Taken: true, priceSol: 5, peakPriceSol: 5 });
  assert.equal(afterTp1?.reason, "momentum_tp2");
  assert.equal(afterTp1?.sellFraction, 0.5);
  assert.equal(
    momentumExit({ ...held, tp1Taken: true, tp2Taken: true, peakPriceSol: 6, priceSol: 4.1 })?.reason,
    "momentum_moonbag",
  );
  assert.equal(
    momentumExit({ ...held, tp1Taken: true, tp2Taken: true, peakPriceSol: 6, priceSol: 4.3 }),
    null,
  );
  assert.equal(
    momentumExit({
      ...held,
      tp1Taken: true,
      tp2Taken: true,
      peakPriceSol: 6,
      priceSol: 6,
      sellVolume15mUsd: 5,
      buyVolume15mUsd: 1,
    })?.reason,
    "momentum_moonbag",
  );
  assert.equal(
    momentumExit({
      ...held,
      tp1Taken: true,
      tp2Taken: true,
      peakPriceSol: 6,
      priceSol: 6,
      sellVolume15mUsd: 5,
      buyVolume15mUsd: 1,
      volume15mComplete: false,
    }),
    null,
  );
  assert.equal(momentumExit({ ...held, tp1Taken: false, priceSol: 0.5 })?.reason, "momentum_sl");
});

test("slippage is 15% under $150k and 8% at or above it", () => {
  assert.equal(momentumSlippagePct(149_999), 15);
  assert.equal(momentumSlippagePct(150_000), 8);
  const config = loadConfig({ PAPER_START_BALANCE_SOL: "1" });
  const turbo = turboFees(config);
  assert.equal(turbo.tipSol, config.jitoTipMaxSol);
  assert.equal(turbo.priorityFeeSol, Math.max(config.priorityFeeSol, config.priorityFeeMaxLamports / 1e9));
});

test("strategy defaults to sniper and momentum is selected by env", () => {
  assert.equal(loadConfig({}).strategy, "sniper");
  assert.equal(loadConfig({}).momentumPollSec, 20);
  assert.equal(loadConfig({}).momentumResistanceCandles, 6);
  const momentum = loadConfig({ STRATEGY: "momentum", PAPER_START_BALANCE_SOL: "1", MOMENTUM_POLL_SEC: "25" });
  assert.equal(momentum.strategy, "momentum");
  assert.equal(momentum.momentumPollSec, 25);
  assert.throws(() => loadConfig({ STRATEGY: "grid" }), ConfigError);
  assert.throws(() => loadConfig({ STRATEGY: "momentum" }), /PAPER_START_BALANCE_SOL/);
  assert.throws(() => loadConfig({ MOMENTUM_POLL_SEC: "4" }), ConfigError);
});

test("DexScreener and GeckoTerminal payloads parse into pair, candles, and makers", () => {
  assert.deepEqual(
    parseSolanaMints([{ chainId: "solana", tokenAddress: "Mint1" }, { chainId: "ethereum", tokenAddress: "nope" }]),
    ["Mint1"],
  );
  const pair = parseDexPair(
    {
      pairs: [
        {
          chainId: "solana",
          dexId: "pumpswap",
          pairAddress: "Pair1",
          baseToken: { address: "Mint1", symbol: "AAA", name: "Aaa" },
          priceUsd: "0.1",
          marketCap: 100_000,
          liquidity: { usd: 20_000 },
          volume: { m5: 40_000 },
          txns: { m5: { buys: 20, sells: 5 } },
          pairCreatedAt: 1_000,
        },
      ],
    },
    "Mint1",
  );
  assert.equal(pair?.dexId, "pumpswap");
  assert.equal(pair?.volume5mUsd, 40_000);
  const parsed = parseGeckoCandles({
    data: { attributes: { ohlcv_list: [[1_700_000_000, 1, 2, 0.5, 1.5, 10]] } },
  });
  assert.equal(parsed[0]?.ts, 1_700_000_000_000);
  assert.equal(parsed[0]?.high, 2);
  const now = Date.parse("2026-01-01T00:30:00Z");
  const trades = parseGeckoTrades(
    {
      data: [
        {
          attributes: {
            block_timestamp: "2026-01-01T00:20:00Z",
            tx_from_address: "a",
            kind: "buy",
            volume_in_usd: "3",
          },
        },
        {
          attributes: {
            block_timestamp: "2026-01-01T00:25:00Z",
            tx_from_address: "b",
            kind: "sell",
            volume_in_usd: "12",
          },
        },
      ],
    },
    now,
  );
  assert.equal(trades.makers1h, 2);
  assert.equal(trades.makersComplete, true);
  assert.equal(trades.sellVolume15mUsd, 12);
  assert.equal(trades.buyVolume15mUsd, 3);
});

test("a paper momentum tick buys a breakout and the stop sells the position", async () => {
  const dir = mkdtempSync(join(tmpdir(), "momentum-"));
  const config = loadConfig({
    STRATEGY: "momentum",
    PAPER_START_BALANCE_SOL: "10",
    DATA_DIR: dir,
    MAX_DAILY_LOSS_SOL: "1",
  });
  const facts = passingFacts();
  const executor = new PaperExecutor(config.paper);
  const positions = new PositionBook(join(dir, "positions.json"));
  const trades = new TradeLog(join(dir, "trades.jsonl"));
  const balance = new PaperBalance(join(dir, "paper-balance.json"), 10);
  let priceUsd = facts.price;
  const runner = new MomentumRunner({
    config,
    executor,
    positions,
    trades,
    log: new Logger(),
    solUsd: () => 100,
    now: () => new Date(facts.nowMs),
    paperBalance: balance,
    market: {
      async candidates() {
        return ["Mint1"];
      },
      async pair() {
        return {
          mint: "Mint1",
          pairAddress: "Pair1",
          dexId: "pumpswap",
          symbol: "AAA",
          name: "Aaa",
          priceUsd,
          marketCapUsd: facts.marketCapUsd,
          liquidityUsd: facts.liquidityUsd,
          volume5mUsd: facts.volume5mUsd,
          buys5m: facts.buys5m,
          sells5m: facts.sells5m,
          pairCreatedAtMs: facts.pairCreatedAtMs,
        };
      },
      async candles() {
        return facts.candles;
      },
      async trades() {
        return {
          makers1h: 300,
          makersComplete: true,
          buyVolume15mUsd: 10,
          sellVolume15mUsd: 1,
          volume15mComplete: true,
        };
      },
    },
    chain: async () => ({ mintOk: true, mintReason: null, top10Pct: 10, devPct: 1 }),
  });
  const launch: MarketLaunch = {
    kind: "launch",
    mint: "Mint1",
    name: "Aaa",
    symbol: "AAA",
    creator: "dev",
    signature: "sig",
    initialBuyTokens: 1,
    quoteMint: null,
    solQuoted: true,
    priceSol: 0.0001,
    marketCapSol: 1,
    vSolSol: 1,
    vTokens: 1,
    bondingCurveKey: null,
    slot: 10,
  };
  runner.noteLaunch(launch);
  runner.noteGraduation({ kind: "graduation", mint: "Mint1", pool: "pump-amm", baseTokens: null, quoteSol: null });
  await runner.tick();
  const open = positions.get("Mint1");
  assert.ok(open?.momentum);
  assert.equal(open?.momentumPool, "pump-amm");
  assert.equal(trades.readAll().at(-1)?.reason, "entry");
  assert.equal(trades.readAll().at(-1)?.entryScore != null && trades.readAll().at(-1)!.entryScore! > 0, true);
  assert.ok(balance.cash() < 10);
  const entry = open!.entryPriceSol;
  priceUsd = entry * 100 * 0.7;
  await runner.tick();
  assert.equal(positions.get("Mint1"), undefined);
  const sell = trades.readAll().at(-1);
  assert.equal(sell?.reason, "momentum_sl");
  assert.equal(sell?.side, "sell");
  assert.equal(sell?.bundle, "jito");
  assert.ok((sell?.jitoTipSol ?? 0) > 0);
});
