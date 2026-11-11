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

test("a throwing trade handler does not kill the socket loop", () => {
  const sockets: FakeSocket[] = [];
  const stream = new PumpDevStream(
    "wss://pumpdev.io/ws",
    new Logger(),
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    () => 1_000,
  );
  stream.start(() => {
    throw new Error("handler blew up");
  });
  sockets[0]?.emit("open");
  assert.doesNotThrow(() => {
    sockets[0]?.emit("message", JSON.stringify({
      txType: "buy",
      mint: "MintA",
      signature: "sig",
      traderPublicKey: "trader",
      quoteMint: "So11111111111111111111111111111111111111112",
      marketCapSol: 30,
    }));
  });
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

class CaptureLogger extends Logger {
  readonly lines: string[] = [];
  override info(message: string, fields?: Record<string, unknown>): void {
    this.lines.push(this.format("info", message, fields));
  }
  override error(message: string, fields?: Record<string, unknown>): void {
    this.lines.push(this.format("error", message, fields));
  }
}

test("auth is sent before subscribe on open and on reconnect, and the key stays out of logs", () => {
  const key = "pumpdev-test-key-value-123456";
  const log = new CaptureLogger();
  const sockets: FakeSocket[] = [];
  const stream = new PumpDevStream(
    `wss://pumpdev.io/ws?key=${key}`,
    log,
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    () => 5,
    { apiKey: key },
  );
  stream.start(() => {});
  sockets[0]?.emit("open");
  const first = (sockets[0]?.sent ?? []).map((line) => JSON.parse(line) as { method?: string; key?: string });
  assert.equal(first[0]?.method, "auth");
  assert.equal(first[0]?.key, key);
  assert.ok(first.findIndex((row) => row.method === "subscribeNewToken") > 0);
  sockets[0]?.emit("message", JSON.stringify({ type: "auth", status: "free", tier: "anonymous", key }));
  const logged = log.lines.join("\n");
  assert.equal(logged.includes(key), false);
  assert.match(logged, /anonymous/);
  assert.match(logged, /ws auth anonymous/);
  sockets[0]?.emit("close");
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      sockets[1]?.emit("open");
      const again = JSON.parse(sockets[1]?.sent[0] ?? "{}") as { method?: string; key?: string };
      assert.equal(again.method, "auth");
      assert.equal(again.key, key);
      const subscribed = (sockets[1]?.sent ?? []).map((line) => JSON.parse(line) as { method?: string });
      assert.ok(subscribed.findIndex((row) => row.method === "subscribeNewToken") > 0);
      assert.equal(log.lines.join("\n").includes(key), false);
      stream.stop();
      resolve();
    }, 20);
  });
});

test("an auth ack raises the subscription cap and a pro tier is not warned", () => {
  const key = "pumpdev-test-key-value-123456";
  const log = new CaptureLogger();
  const sockets: FakeSocket[] = [];
  const stream = new PumpDevStream(
    "wss://pumpdev.io/ws",
    log,
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    () => 1_000,
    { apiKey: key, maxSubscriptions: 25 },
  );
  stream.start(() => {});
  sockets[0]?.emit("open");
  const mints = ["A", "B", "C", "D", "E", "F"];
  stream.subscribeTrades(mints);
  const subscribed = () =>
    (sockets[0]?.sent ?? [])
      .map((line) => JSON.parse(line) as { method?: string; keys?: string[] })
      .filter((row) => row.method === "subscribeTokenTrade")
      .flatMap((row) => row.keys ?? []);
  assert.deepEqual(subscribed().sort(), ["A", "B", "C", "D", "E"]);
  sockets[0]?.emit("message", JSON.stringify({ type: "auth", status: "ok", tier: "pro", limit: 1000 }));
  assert.ok(subscribed().includes("F"));
  assert.equal(log.lines.join("\n").includes("ws auth anonymous"), false);
  assert.equal(log.lines.join("\n").includes(key), false);
  stream.stop();
});
