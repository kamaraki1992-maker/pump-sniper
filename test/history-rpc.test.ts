import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { RpcCreatorHistory } from "../src/history.js";
import { Logger } from "../src/logger.js";
import { createRpcFetch, createRpcStats, startRpcPressureLog } from "../src/rpc-limit.js";

test("one creator is fetched once, cached, and a 429 does not reject", async () => {
  let now = 0;
  let calls = 0;
  const limits: number[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { method?: string; params?: unknown[] };
    if (body.method === "getSignaturesForAddress") {
      const opts = body.params?.[1] as { limit?: number } | undefined;
      if (typeof opts?.limit === "number") limits.push(opts.limit);
    }
    if (calls === 1) return new Response("busy", { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const stats = createRpcStats();
  const rpc = createRpcFetch({
    rps: 100,
    cacheTtlMs: 0,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    random: () => 0,
    fetchImpl,
    stats,
  });
  const history = new RpcCreatorHistory(loadConfig({}), new Logger(), () => now, rpc);
  const [first, second] = await Promise.all([history.lookup("CreatorA"), history.lookup("CreatorA")]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls, 2);
  assert.ok(limits.length >= 1);
  assert.ok(limits.every((limit) => limit === 8));
  assert.equal(stats.http429, 1);
  assert.equal(stats.retries, 1);
  const before = calls;
  const again = await history.lookup("CreatorA");
  assert.equal(again.ok, true);
  assert.equal(calls, before);

  now += 5 * 60_000;
  let failed = 0;
  const down: typeof fetch = async () => {
    failed += 1;
    return new Response("busy", { status: 429 });
  };
  const limited = createRpcFetch({
    rps: 100,
    cacheTtlMs: 0,
    maxAttempts: 2,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    random: () => 0.5,
    fetchImpl: down,
  });
  const missed = new RpcCreatorHistory(loadConfig({}), new Logger(), () => now, limited);
  const decision = await missed.lookup("CreatorB");
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "creator-history-unavailable");
  const used = failed;
  const cachedMiss = await missed.lookup("CreatorB");
  assert.equal(cachedMiss.reason, "creator-history-unavailable");
  assert.equal(failed, used);
});

test("rpc pressure is one periodic line, not one line per 429", () => {
  const stats = createRpcStats();
  const entries: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const stop = startRpcPressureLog({ info: (message, fields) => entries.push({ message, fields }) }, stats, 60_000);
  stats.http429 = 40;
  stats.retries = 12;
  stop();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.message, "rpc pressure");
  assert.equal(entries[0]?.fields?.http429, 40);
  assert.equal(entries[0]?.fields?.retries, 12);
  entries.length = 0;
  stop();
  assert.equal(entries.length, 0);
});
