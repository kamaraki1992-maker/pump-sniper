import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SniperBot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { parsePumpDevMessage, parsePumpPortalMessage, WSOL_MINT } from "../src/pricing.js";
import { PositionBook } from "../src/positions.js";
import { TradeLog } from "../src/report.js";
import { PORTAL_SUBSCRIBE_BATCH, PumpDevStream, type PumpSocket } from "../src/stream.js";
import type { FillResult, MarketLaunch } from "../src/types.js";

class FakeSocket implements PumpSocket {
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, Array<(...args: never[]) => void>>();
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit("close");
  }
  on(event: "open" | "message" | "close" | "error", cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...(args as never[]));
  }
}

const CREATE = {
  txType: "create",
  signature: "4mcbFv4WTEPqbqXF5hN1WksNkzw8H97Y9vhCpv1EeG1Dcj3UMkg26CLNktbQk8J5o53S8ArZGaJTuZukK5aWWQg3",
  mint: "FNzXkQwLWzRm6Z1jJT9gnVH2pHiKiYLw3Ry1btY5KvLU",
  traderPublicKey: "9HkFiXkZgp3fAwNVKDwabLKSvfJExJVDoUpR4Meo7XD7",
  name: "Example",
  symbol: "EX",
  initialBuy: 59_141_732.283464,
  marketCapSol: 31.316014290152186,
  bondingCurveKey: "43qMNRPVo1oB8XYc9YZRuN9fKYSn782X5TnreNKWgS5b",
  vSolInBondingCurve: 31.749999999999982,
  vTokensInBondingCurve: 1_013_858_267.716536,
  pool: "pump",
  slot: 321,
  solAmount: 1.75,
};

test("PumpPortal reserves match the normalized PumpDev curve", () => {
  const portal = parsePumpPortalMessage(CREATE);
  const pumpdev = parsePumpDevMessage({
    txType: "create",
    mint: CREATE.mint,
    traderPublicKey: CREATE.traderPublicKey,
    name: CREATE.name,
    symbol: CREATE.symbol,
    initialBuy: CREATE.initialBuy,
    marketCapSol: CREATE.marketCapSol,
    bondingCurveKey: CREATE.bondingCurveKey,
    vSolInBondingCurve: 31.749999999999982 * 1e9,
    vTokensInBondingCurve: 1_013_858_267.716536 * 1e6,
    quoteMint: WSOL_MINT,
    slot: 321,
    solAmount: 1.75,
  });
  assert.equal(portal?.kind, "launch");
  assert.equal(pumpdev?.kind, "launch");
  if (portal?.kind !== "launch" || pumpdev?.kind !== "launch") return;
  assert.equal(portal.solQuoted, true);
  assert.equal(portal.creator, CREATE.traderPublicKey);
  assert.equal(portal.slot, 321);
  assert.equal(portal.solAmount, 1.75);
  assert.ok(Math.abs((portal.vSolSol ?? 0) - (pumpdev.vSolSol ?? 0)) < 1e-6);
  assert.ok(Math.abs((portal.vTokens ?? 0) - (pumpdev.vTokens ?? 0)) < 1e-3);
  assert.ok(Math.abs((portal.priceSol ?? 0) - (pumpdev.priceSol ?? 0)) < 1e-18);
  assert.ok(Math.abs(portal.initialBuyTokens - CREATE.initialBuy) < 1e-6);

  const buy = parsePumpPortalMessage({
    txType: "buy",
    mint: CREATE.mint,
    traderPublicKey: "7t3Rn6w9ou2kS1cyZjW28G4wkb6N3arLPsqGVogkyQBD",
    signature: "buy-sig",
    solAmount: 0.7,
    tokenAmount: 21_870_594.372929,
    marketCapSol: 32.712100031065454,
    vSolInBondingCurve: 32.44999999999995,
    vTokensInBondingCurve: 991_987_673.343607,
    pool: "pump",
  });
  assert.equal(buy?.kind, "trade");
  if (buy?.kind !== "trade") return;
  assert.equal(buy.txType, "buy");
  assert.equal(buy.solAmount, 0.7);
  assert.equal(buy.venue, undefined);
  assert.ok(Math.abs((buy.vSolSol ?? 0) - 32.45) < 1e-6);

  const amm = parsePumpPortalMessage({ ...CREATE, txType: "buy", pool: "pumpswap" });
  assert.equal(amm?.kind, "trade");
  if (amm?.kind === "trade") assert.equal(amm.venue, "pumpswap");
  assert.equal(parsePumpPortalMessage({ ...CREATE, pool: "raydium" }), null);
  const migrated = parsePumpPortalMessage({ txType: "migrate", mint: CREATE.mint, pool: "pumpswap" });
  assert.equal(migrated?.kind, "graduation");
});

function portalStream(): { stream: PumpDevStream; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const stream = new PumpDevStream(
    "wss://pumpportal.fun/api/data",
    new Logger(),
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    () => 5,
    { feed: "pumpportal" },
  );
  return { stream, sockets };
}

function methods(socket: FakeSocket | undefined): Array<{ method?: string; keys?: string[] }> {
  return (socket?.sent ?? []).map((line) => JSON.parse(line) as { method?: string; keys?: string[] });
}

test("PumpPortal batches subscribe keys and does not send a PumpDev auth frame", () => {
  const { stream, sockets } = portalStream();
  stream.start(() => {});
  sockets[0]?.emit("open");
  const mints = Array.from({ length: PORTAL_SUBSCRIBE_BATCH + 1 }, (_, index) => `Mint${index}`);
  stream.subscribeTrades(mints);
  const sent = methods(sockets[0]);
  assert.equal(sent.some((row) => row.method === "auth"), false);
  assert.equal(sent[0]?.method, "subscribeNewToken");
  const batches = sent.filter((row) => row.method === "subscribeTokenTrade");
  assert.equal(batches.length, 2);
  assert.equal(batches[0]?.keys?.length, PORTAL_SUBSCRIBE_BATCH);
  assert.deepEqual(batches[1]?.keys, ["Mint100"]);
  stream.unsubscribeTrades(["Mint100", "Mint0"]);
  const unsub = methods(sockets[0]).filter((row) => row.method === "unsubscribeTokenTrade");
  assert.deepEqual(unsub.at(-1)?.keys, ["Mint100", "Mint0"]);
  stream.stop();
});

test("a PumpPortal trade key is sent on the subscribe body and stays out of logs", () => {
  const key = "portal-trade-key-not-for-logs";
  const lines: string[] = [];
  const sockets: FakeSocket[] = [];
  const stream = new PumpDevStream(
    "wss://pumpportal.fun/api/data",
    new Logger(),
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    () => 1_000,
    { feed: "pumpportal", apiKey: key },
  );
  const log = stream["log"] as Logger;
  const original = log.info.bind(log);
  const originalError = log.error.bind(log);
  log.info = (message, fields) => {
    lines.push(log.format("info", message, fields));
    original(message, fields);
  };
  log.error = (message, fields) => {
    lines.push(log.format("error", message, fields));
    originalError(message, fields);
  };
  stream.start(() => {});
  sockets[0]?.emit("open");
  stream.subscribeTrades(["MintA"]);
  const trade = methods(sockets[0]).find((row) => row.method === "subscribeTokenTrade") as
    | { apiKey?: string; keys?: string[] }
    | undefined;
  assert.equal(trade?.apiKey, key);
  assert.deepEqual(trade?.keys, ["MintA"]);
  sockets[0]?.emit(
    "message",
    JSON.stringify({
      message: `subscribeTokenTrade needs an API key ${key} funded with at least 0.02 SOL`,
    }),
  );
  const logged = lines.join("\n");
  assert.equal(logged.includes(key), false);
  assert.match(logged, /pumpportal trades require a key/);
  stream.stop();
});

test("PumpPortal reconnect resubscribes tracked mints and not dropped ones", () => {
  const { stream, sockets } = portalStream();
  stream.start(() => {});
  sockets[0]?.emit("open");
  stream.subscribeTrades(["Keep", "Drop"]);
  stream.unsubscribeTrades(["Drop"]);
  sockets[0]?.emit("close");
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      sockets[1]?.emit("open");
      const sent = methods(sockets[1]);
      assert.equal(sent[0]?.method, "subscribeNewToken");
      assert.equal(sent.some((row) => row.method === "auth"), false);
      const keys = sent.filter((row) => row.method === "subscribeTokenTrade").flatMap((row) => row.keys ?? []);
      assert.deepEqual(keys, ["Keep"]);
      stream.stop();
      resolve();
    }, 20);
  });
});

test("a PumpPortal creator sell is a dev_sell", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portal-dev-"));
  const config = loadConfig({ DATA_DIR: dir });
  config.entryWatchMaxSec = 0;
  config.earlyExitWindowSec = 0;
  config.tradesPath = join(dir, "trades.jsonl");
  config.positionsPath = join(dir, "positions.json");
  const positions = new PositionBook(config.positionsPath);
  const trades = new TradeLog(config.tradesPath);
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
  const bot = new SniperBot({
    config,
    executor: { buy: async () => fill, sell: async () => fill },
    history: { lookup: async () => ({ ok: true }) },
    positions,
    trades,
    log: new Logger(),
    solUsd: () => 100,
    solQuote: () => ({ usd: 100, updatedAtMs: Date.parse("2026-11-04T12:00:00.000Z") }),
    now: () => new Date("2026-11-04T12:00:00.000Z"),
    sleep: async () => {},
    subscribeMint: () => {},
    unsubscribeMint: () => {},
    readCurveReserves: async () => ({ vSol: 30, vTokens: 1_073_000_000 }),
  });
  const launch = parsePumpPortalMessage({
    ...CREATE,
    initialBuy: 1_000_000,
    marketCapSol: 28,
    vSolInBondingCurve: 30,
    vTokensInBondingCurve: 1_073_000_000,
  });
  assert.equal(launch?.kind, "launch");
  if (launch?.kind !== "launch") return;
  const order: MarketLaunch = { ...launch, priceSol: 1 };
  await bot.onLaunch(order);
  assert.equal(positions.list().length, 1);
  const sell = parsePumpPortalMessage({
    txType: "sell",
    mint: CREATE.mint,
    traderPublicKey: CREATE.traderPublicKey,
    signature: "dev-sell",
    solAmount: 0.4,
    tokenAmount: 10_000,
    marketCapSol: 40,
    vSolInBondingCurve: 32,
    vTokensInBondingCurve: 1_000_000_000,
    pool: "pump",
  });
  assert.equal(sell?.kind, "trade");
  if (sell?.kind !== "trade") return;
  await bot.onTrade(sell);
  assert.equal(trades.readAll().find((row) => row.side === "sell")?.reason, "dev_sell");
});
