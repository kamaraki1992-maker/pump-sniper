import assert from "node:assert/strict";
import { test } from "node:test";
import { createRpcFetch, TokenBucket } from "../src/rpc-limit.js";

test("the token bucket waits once the per-second budget is spent", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const bucket = new TokenBucket(2, {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  await bucket.acquire();
  await bucket.acquire();
  await bucket.acquire();
  assert.equal(sleeps.length, 1);
  assert.ok((sleeps[0] ?? 0) >= 500);
});

test("429 responses back off with jitter, then a short cache skips the network", async () => {
  let now = 0;
  const sleeps: number[] = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("busy", { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { amount: "1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const rpc = createRpcFetch({
    rps: 100,
    cacheTtlMs: 5_000,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    random: () => 1,
    fetchImpl,
  });
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: ["Mint"] }),
  };
  const first = await rpc("https://rpc.example", init);
  assert.equal(calls, 2);
  assert.equal(sleeps[0], 260);
  assert.equal(((await first.json()) as { result: { amount: string } }).result.amount, "1");

  const second = await rpc("https://rpc.example", init);
  assert.equal(calls, 2);
  assert.equal(((await second.json()) as { result: { amount: string } }).result.amount, "1");
});

test("an HTTP 200 JSON-RPC error is not cached", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param: not a Token mint" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }), { status: 200 });
  };
  const rpc = createRpcFetch({
    rps: 50,
    cacheTtlMs: 5_000,
    now: () => 0,
    sleep: async () => {},
    random: () => 0,
    fetchImpl,
  });
  const init = {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: ["Mint"] }),
  };
  const first = (await (await rpc("https://rpc.example", init)).json()) as { error?: { message: string } };
  assert.match(first.error?.message ?? "", /not a Token mint/);
  const second = (await (await rpc("https://rpc.example", init)).json()) as { result?: { value: unknown[] } };
  assert.equal(calls, 2);
  assert.deepEqual(second.result?.value, []);
});

test("a failed read is not cached and a simulation is not cached", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: calls }), { status: 200 });
  };
  const rpc = createRpcFetch({
    rps: 50,
    cacheTtlMs: 5_000,
    now: () => 0,
    sleep: async () => {},
    random: () => 0,
    fetchImpl,
  });
  const sim = {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [] }),
  };
  await rpc("https://rpc.example", sim);
  await rpc("https://rpc.example", sim);
  assert.equal(calls, 2);
});
