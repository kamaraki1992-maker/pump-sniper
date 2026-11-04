import assert from "node:assert/strict";
import { test } from "node:test";
import { Logger } from "../src/logger.js";
import { parsePumpDevMessage } from "../src/pricing.js";
import { nextBackoffMs, PumpDevStream, type PumpSocket } from "../src/stream.js";

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

test("reconnect backoff starts at 1s and caps at 30s", () => {
  assert.equal(nextBackoffMs(0), 1_000);
  assert.equal(nextBackoffMs(1), 2_000);
  assert.equal(nextBackoffMs(2), 4_000);
  assert.equal(nextBackoffMs(10), 30_000);
});

test("a SOL create from the pumpdev socket becomes a priced launch", () => {
  const event = parsePumpDevMessage({
    txType: "create",
    signature: "sig",
    mint: "9hjuugQZ3nSHfVGzPABwCFKvkCZVeXNn6GrtDPQoam9i",
    traderPublicKey: "9NyMjr5urtKG4CYeZXhhCoAfnFCX47hjPHN7XUg7cG3f",
    name: "Furlong",
    symbol: "FURLONG",
    initialBuy: 0,
    quoteMint: "So11111111111111111111111111111111111111112",
    vTokensInBondingCurve: 1_073_000_000_000_000,
    vSolInBondingCurve: 30_000_000_000,
    marketCapSol: 27.958993476234856,
    bondingCurveKey: "curve",
  });
  assert.equal(event?.kind, "launch");
  if (event?.kind !== "launch") return;
  assert.equal(event.solQuoted, true);
  assert.equal(event.initialBuyTokens, 0);
  assert.ok(event.priceSol !== null && Math.abs(event.priceSol - 27.958993476234856 / 1e9) < 1e-18);
});

test("control frames and non-SOL quotes are not buys", () => {
  assert.equal(parsePumpDevMessage({ type: "subscribed", method: "subscribeNewToken" }), null);
  const event = parsePumpDevMessage({
    txType: "create",
    mint: "OtherMint",
    traderPublicKey: "Creator",
    quoteMint: "DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF",
    initialBuy: 0,
    marketCapQuote: 500,
  });
  assert.equal(event?.kind, "launch");
  if (event?.kind !== "launch") return;
  assert.equal(event.solQuoted, false);
});

test("a held mint is subscribed on open, acked, and dropped on unsubscribe", () => {
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  const stream = new PumpDevStream(
    "wss://pumpdev.io/ws",
    new Logger(),
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    () => 5,
  );
  stream.start((event) => {
    if (event.kind === "trade") events.push(event.mint);
  });
  stream.subscribeTrades(["MintA"]);
  assert.equal(sockets[0]?.sent.length, 0);
  sockets[0]?.emit("open");
  const sent = () => (sockets[0]?.sent ?? []).map((line) => JSON.parse(line) as { method: string; keys?: string[] });
  assert.equal(sent().some((row) => row.method === "subscribeNewToken"), true);
  assert.deepEqual(sent().find((row) => row.method === "subscribeTokenTrade")?.keys, ["MintA"]);
  sockets[0]?.emit(
    "message",
    JSON.stringify({ type: "subscribed", method: "subscribeTokenTrade", keys: ["MintA"] }),
  );
  assert.equal(stream.tradeLive("MintA"), true);
  sockets[0]?.emit(
    "message",
    JSON.stringify({
      txType: "buy",
      mint: "MintA",
      signature: "sig",
      traderPublicKey: "trader",
      quoteMint: "So11111111111111111111111111111111111111112",
      marketCapSol: 30,
    }),
  );
  assert.deepEqual(events, ["MintA"]);
  stream.unsubscribeTrades(["MintA"]);
  assert.equal(stream.tradeLive("MintA"), false);
  assert.deepEqual(sent().at(-1), { method: "unsubscribeTokenTrade", keys: ["MintA"] });
  stream.stop();
});

test("reconnect resubscribes only mints still held", () => {
  const sockets: FakeSocket[] = [];
  const stream = new PumpDevStream(
    "wss://pumpdev.io/ws",
    new Logger(),
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    () => 5,
  );
  stream.start(() => {});
  sockets[0]?.emit("open");
  stream.subscribeTrades(["MintA", "MintB"]);
  stream.unsubscribeTrades(["MintA"]);
  sockets[0]?.emit("close");
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      sockets[1]?.emit("open");
      const keys = (sockets[1]?.sent ?? [])
        .map((line) => JSON.parse(line) as { method: string; keys?: string[] })
        .filter((row) => row.method === "subscribeTokenTrade")
        .flatMap((row) => row.keys ?? []);
      assert.deepEqual(keys, ["MintB"]);
      stream.stop();
      resolve();
    }, 20);
  });
});
