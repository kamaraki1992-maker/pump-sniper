import assert from "node:assert/strict";
import { test } from "node:test";
import { bondingCurveAddress, fetchCurveReserves, RpcCurveWatch, realSolFromCurveData } from "../src/curve-watch.js";
import { Logger } from "../src/logger.js";
import { redactRpcUrl } from "../src/redact.js";
import { reservesDropped } from "../src/risk.js";

class FakeSocket {
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

function curveData(realLamports: bigint): Buffer {
  const data = Buffer.alloc(48);
  data.writeBigUInt64LE(realLamports, 32);
  return data;
}

test("real SOL reserves are the u64 lamports at offset 32", () => {
  assert.equal(realSolFromCurveData(curveData(2_500_000_000n)), 2.5);
  assert.equal(realSolFromCurveData(Buffer.alloc(8)), null);
  assert.equal(reservesDropped(10, 7.9, 20), true);
  assert.equal(reservesDropped(10, 8, 20), false);
});

test("fetchCurveReserves calls getAccountInfo on the bonding curve", async () => {
  const mint = "6vkymtWzVndBc99q8aZJ5GatxKSBoFHyekP439G7pump";
  const data = Buffer.alloc(49);
  data.writeBigUInt64LE(900_000_000_000_000n, 8);
  data.writeBigUInt64LE(48_000_000_000n, 16);
  let method = "";
  let account = "";
  const reserves = await fetchCurveReserves("https://rpc.example", mint, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: [string] };
    method = body.method;
    account = body.params[0];
    return new Response(
      JSON.stringify({ result: { value: { data: [data.toString("base64"), "base64"] } } }),
      { status: 200 },
    );
  });
  assert.equal(method, "getAccountInfo");
  assert.equal(account, bondingCurveAddress(mint, null));
  assert.ok(reserves);
  assert.equal(reserves?.vSol, 48);
  assert.equal(reserves?.vTokens, 900_000_000);
});

test("closing a position unsubscribes its bonding curve", () => {
  const sockets: FakeSocket[] = [];
  const watch = new RpcCurveWatch(
    "wss://example.test/?api-key=supersecretkey123",
    new Logger(),
    () => {},
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    () => 1,
  );
  watch.start();
  sockets[0]?.emit("open");
  watch.watch("Mint", "Curve111");
  const sub = JSON.parse(sockets[0]?.sent.at(-1) ?? "{}") as { id: number; method: string; params: unknown[] };
  assert.equal(sub.method, "accountSubscribe");
  assert.equal(sub.params[0], "Curve111");
  sockets[0]?.emit(
    "message",
    JSON.stringify({ jsonrpc: "2.0", id: sub.id, result: 7 }),
  );
  assert.equal(watch.isLive("Mint"), true);
  watch.unwatch("Mint");
  const unsub = JSON.parse(sockets[0]?.sent.at(-1) ?? "{}") as { method: string; params: number[] };
  assert.equal(unsub.method, "accountUnsubscribe");
  assert.deepEqual(unsub.params, [7]);
  assert.equal(watch.isLive("Mint"), false);
  watch.stop();
});

test("reconnect resubscribes every open curve", () => {
  const sockets: FakeSocket[] = [];
  const watch = new RpcCurveWatch(
    "wss://example.test/?api-key=supersecretkey123",
    new Logger(),
    () => {},
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
    () => 5,
  );
  watch.start();
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      watch.watch("MintA", "CurveA");
      watch.watch("MintB", "CurveB");
      sockets[0]?.emit("close");
      setTimeout(() => {
        const methods = (sockets[1]?.sent ?? []).map((line) => (JSON.parse(line) as { method: string }).method);
        const curves = (sockets[1]?.sent ?? []).map(
          (line) => (JSON.parse(line) as { params: string[] }).params[0],
        );
        assert.equal(methods.filter((method) => method === "accountSubscribe").length, 2);
        assert.deepEqual(curves.sort(), ["CurveA", "CurveB"]);
        watch.stop();
        resolve();
      }, 20);
    }, 10);
  });
});

test("api-key query values never appear in logs", () => {
  const url = "wss://mainnet.helius-rpc.com/?api-key=supersecretkey123";
  const cleaned = redactRpcUrl(`connect failed ${url}`);
  assert.equal(cleaned.includes("supersecretkey123"), false);
  assert.match(cleaned, /api-key=\[REDACTED\]/);
  const logger = new Logger([ "supersecretkey123" ]);
  const line = logger.format("error", "socket", { error: url });
  assert.equal(line.includes("supersecretkey123"), false);
});
