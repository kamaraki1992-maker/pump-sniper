import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SniperBot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { HeliusFeed, HELIUS_LOG_COMMITMENT, type HeliusSocket } from "../src/helius-feed.js";
import {
  CREATE_EVENT_DISC,
  eventsFromLogs,
  PUMP_LOG_PROGRAM,
  TRADE_EVENT_DISC,
  type LogsNotice,
} from "../src/helius-logs.js";
import { Logger } from "../src/logger.js";
import { parsePumpDevMessage, priceFromReserves, WSOL_MINT } from "../src/pricing.js";
import { PositionBook } from "../src/positions.js";
import { TradeLog } from "../src/report.js";
import type { FillResult, MarketEvent } from "../src/types.js";

const VSOL = 30_000_000_000n;
const VTOK = 1_073_000_000_000_000n;

class FakeSocket implements HeliusSocket {
  readonly sent: string[] = [];
  pinged = 0;
  private readonly handlers = new Map<string, Array<(...args: never[]) => void>>();
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit("close");
  }
  ping(): void {
    this.pinged += 1;
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

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function u64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function text(value: string): Buffer {
  return Buffer.concat([u32(Buffer.byteLength(value)), Buffer.from(value)]);
}

function key(value: PublicKey): Buffer {
  return Buffer.from(value.toBytes());
}

function tradeData(input: {
  mint: PublicKey;
  user: PublicKey;
  isBuy: boolean;
  creator?: PublicKey;
  extra?: number;
  vSol?: bigint;
}): Buffer {
  const head = Buffer.concat([
    TRADE_EVENT_DISC,
    key(input.mint),
    u64(1_750_000_000n),
    u64(59_141_732n * 1_000_000n),
    Buffer.from([input.isBuy ? 1 : 0]),
    key(input.user),
    u64(1_700_000_000n),
    u64(input.vSol ?? VSOL),
    u64(VTOK),
  ]);
  if (!input.creator) return head;
  return Buffer.concat([
    head,
    u64(1n),
    u64(2n),
    key(input.user),
    u64(100n),
    u64(3n),
    key(input.creator),
    Buffer.alloc(input.extra ?? 40),
  ]);
}

function createData(input: { mint: PublicKey; curve: PublicKey; user: PublicKey; creator: PublicKey }): Buffer {
  return Buffer.concat([
    CREATE_EVENT_DISC,
    text("Example"),
    text("EX"),
    text("https://example.test/meta"),
    key(input.mint),
    key(input.curve),
    key(input.user),
    key(input.creator),
    u64(1_700_000_000n),
    u64(VTOK),
    u64(VSOL),
    u64(793_100_000_000_000n),
    u64(1_000_000_000_000_000n),
  ]);
}

function notice(logs: string[], extra: Partial<LogsNotice> = {}): unknown {
  return {
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      result: {
        context: { slot: extra.slot ?? 99 },
        value: {
          signature: extra.signature ?? "sig-1",
          err: extra.err ?? null,
          logs,
        },
      },
    },
  };
}

test("create and both TradeEvent layouts match the PumpDev reserve price", () => {
  const mint = Keypair.generate().publicKey;
  const curve = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const expected = priceFromReserves(Number(VSOL), Number(VTOK));
  const pumpdev = parsePumpDevMessage({
    txType: "buy",
    mint: mint.toBase58(),
    traderPublicKey: user.toBase58(),
    quoteMint: WSOL_MINT,
    vSolInBondingCurve: Number(VSOL),
    vTokensInBondingCurve: Number(VTOK),
    solAmount: 1.75,
  });
  for (const data of [
    tradeData({ mint, user, isBuy: true }),
    tradeData({ mint, user, isBuy: false, creator }),
  ]) {
    const decoded = eventsFromLogs({
      slot: 42,
      signature: "trade-sig",
      err: null,
      logs: [`Program data: ${data.toString("base64")}`],
    });
    assert.equal(decoded.failures, 0);
    assert.equal(decoded.events.length, 1);
    const event = decoded.events[0];
    assert.equal(event?.kind, "trade");
    if (event?.kind !== "trade" || pumpdev?.kind !== "trade") continue;
    assert.equal(event.slot, 42);
    assert.equal(event.solAmount, 1.75);
    assert.ok(Math.abs((event.vSolSol ?? 0) - (pumpdev.vSolSol ?? 0)) < 1e-6);
    assert.ok(Math.abs((event.vTokens ?? 0) - (pumpdev.vTokens ?? 0)) < 1);
    assert.ok(Math.abs((event.priceSol ?? 0) - (expected ?? 0)) < 1e-18);
    assert.ok(Math.abs((event.priceSol ?? 0) - (pumpdev.priceSol ?? 0)) < 1e-18);
  }

  const created = eventsFromLogs({
    slot: 7,
    signature: "create-sig",
    err: null,
    logs: [`Program data: ${createData({ mint, curve, user, creator }).toString("base64")}`],
  });
  assert.equal(created.failures, 0);
  const launch = created.events[0];
  assert.equal(launch?.kind, "launch");
  if (launch?.kind !== "launch") return;
  assert.equal(launch.creator, creator.toBase58());
  assert.equal(launch.bondingCurveKey, curve.toBase58());
  assert.equal(launch.name, "Example");
  assert.ok(Math.abs((launch.priceSol ?? 0) - (expected ?? 0)) < 1e-18);

  const unknown = eventsFromLogs({
    slot: 1,
    signature: "other",
    err: null,
    logs: [`Program data: ${Buffer.concat([Buffer.alloc(8, 1), Buffer.alloc(16)]).toString("base64")}`],
  });
  assert.equal(unknown.events.length, 0);
  assert.equal(unknown.failures, 0);
  const broken = eventsFromLogs({
    slot: 1,
    signature: "bad",
    err: null,
    logs: [`Program data: ${TRADE_EVENT_DISC.toString("base64")}`],
  });
  assert.equal(broken.failures, 1);
  const nonSol = eventsFromLogs({
    slot: 1,
    signature: "usdc",
    err: null,
    logs: [`Program data: ${tradeData({ mint, user, isBuy: true, vSol: 0n }).toString("base64")}`],
  });
  assert.equal(nonSol.events.length, 0);
  assert.equal(eventsFromLogs({ slot: 1, signature: "fail", err: { InstructionError: [0, "Custom"] }, logs: [] }).events.length, 0);
});

function feed(options: { now?: () => number; stallMs?: number } = {}): {
  feed: HeliusFeed;
  sockets: FakeSocket[];
  events: MarketEvent[];
} {
  const sockets: FakeSocket[] = [];
  const events: MarketEvent[] = [];
  const stream = new HeliusFeed("wss://mainnet.helius-rpc.com/?api-key=supersecretkey123", new Logger(), {
    stallMs: options.stallMs ?? 1_000,
    now: options.now ?? (() => 0),
    backoff: () => 5,
    sockets: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  stream.start((event) => events.push(event));
  return { feed: stream, sockets, events };
}

test("Helius subscribes once, drops untracked trades, and skips a duplicate or failed tx", () => {
  const { feed: stream, sockets, events } = feed();
  sockets[0]?.emit("open");
  const body = JSON.parse(sockets[0]?.sent[0] ?? "{}") as {
    method?: string;
    params?: [{ mentions?: string[] }, { commitment?: string }];
  };
  assert.equal(body.method, "logsSubscribe");
  assert.deepEqual(body.params?.[0]?.mentions, [PUMP_LOG_PROGRAM]);
  assert.equal(body.params?.[1]?.commitment, HELIUS_LOG_COMMITMENT);
  assert.equal(sockets[0]?.sent[0]?.includes("supersecretkey123"), false);

  const mint = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const logs = [`Program data: ${tradeData({ mint, user, isBuy: true }).toString("base64")}`];
  sockets[0]?.emit("message", JSON.stringify(notice(logs, { signature: "once" })));
  assert.equal(events.length, 0);
  stream.subscribeTrades([mint.toBase58()]);
  sockets[0]?.emit("message", JSON.stringify(notice(logs, { signature: "once" })));
  assert.equal(events.length, 0);
  sockets[0]?.emit("message", JSON.stringify(notice(logs, { signature: "twice" })));
  assert.equal(events.length, 1);
  sockets[0]?.emit("message", JSON.stringify(notice(logs, { signature: "twice" })));
  assert.equal(events.length, 1);
  sockets[0]?.emit("message", JSON.stringify(notice(logs, { signature: "bad", err: { InstructionError: [0, "Custom"] } })));
  assert.equal(events.length, 1);
  stream.stop();
});

test("a Helius creator sell is a dev_sell, and silence reconnects", async () => {
  const mint = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const decoded = eventsFromLogs({
    slot: 3,
    signature: "dev",
    err: null,
    logs: [`Program data: ${tradeData({ mint, user: creator, isBuy: false, creator }).toString("base64")}`],
  });
  const sell = decoded.events[0];
  assert.equal(sell?.kind, "trade");
  if (sell?.kind !== "trade") return;
  assert.equal(sell.txType, "sell");
  assert.equal(sell.trader, creator.toBase58());

  const dir = mkdtempSync(join(tmpdir(), "helius-dev-"));
  const config = loadConfig({ DATA_DIR: dir });
  config.entryWatchMaxSec = 0;
  config.earlyExitWindowSec = 0;
  config.tradesPath = join(dir, "trades.jsonl");
  config.positionsPath = join(dir, "positions.json");
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
    positions: new PositionBook(config.positionsPath),
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
  await bot.onLaunch({
    kind: "launch",
    mint: mint.toBase58(),
    name: "N",
    symbol: "S",
    creator: creator.toBase58(),
    signature: "create",
    initialBuyTokens: 1_000_000,
    quoteMint: WSOL_MINT,
    solQuoted: true,
    priceSol: 1,
    marketCapSol: 30,
    vSolSol: 30,
    vTokens: 1_073_000_000,
    bondingCurveKey: null,
  });
  await bot.onTrade({ ...sell, priceSol: 1, vSolSol: 30, vTokens: 1_073_000_000 });
  assert.equal(trades.readAll().find((row) => row.side === "sell")?.reason, "dev_sell");

  let now = 0;
  const sockets: FakeSocket[] = [];
  const stream = new HeliusFeed("wss://rpc.example/?api-key=supersecretkey123", new Logger(), {
    stallMs: 1_000,
    now: () => now,
    backoff: () => 5,
    sockets: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  stream.start(() => {});
  sockets[0]?.emit("open");
  sockets[0]?.emit("close");
  await new Promise((resolve) => setTimeout(resolve, 20));
  sockets[1]?.emit("open");
  const again = JSON.parse(sockets[1]?.sent[0] ?? "{}") as { method?: string };
  assert.equal(again.method, "logsSubscribe");
  now = 5_000;
  stream.checkStall();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(sockets.length >= 3);
  stream.stop();
});
