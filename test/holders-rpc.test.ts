import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { excludedHolderAccounts, RpcHolderCheck } from "../src/holders.js";
import { Logger } from "../src/logger.js";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function amountB64(amount: bigint): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(amount);
  return buf.toString("base64");
}

test("a fresh Token-2022 mint is retried at processed and the curve is still excluded", async () => {
  const mint = Keypair.generate().publicKey;
  const curveAta = excludedHolderAccounts(mint)[2];
  assert.ok(curveAta);
  const wallet = Keypair.generate().publicKey.toBase58();
  let largestCalls = 0;
  const commitments: string[] = [];
  let now = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const config = body.params[1] as { commitment?: string } | undefined;
    if (config?.commitment) commitments.push(`${body.method}:${config.commitment}`);
    if (body.method === "getAccountInfo") {
      return json({ jsonrpc: "2.0", id: 1, result: { value: { owner: TOKEN_2022 } } });
    }
    if (body.method === "getTokenLargestAccounts") {
      largestCalls += 1;
      if (largestCalls === 1) {
        return json({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "Invalid param: not a Token mint" },
        });
      }
      return json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          value: [
            { address: curveAta, amount: "800000" },
            { address: wallet, amount: "100000" },
          ],
        },
      });
    }
    if (body.method === "getProgramAccounts") {
      return json({ jsonrpc: "2.0", id: 1, result: [] });
    }
    if (body.method === "getTokenSupply") {
      return json({ jsonrpc: "2.0", id: 1, result: { value: { amount: "1000000" } } });
    }
    return json({ jsonrpc: "2.0", id: 1, error: { message: "unexpected" } });
  };
  const check = new RpcHolderCheck("https://rpc.example", 25, fetchImpl, new Logger(), {
    timeoutMs: 1_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const decision = await check.lookup(mint.toBase58());
  assert.equal(largestCalls, 2);
  assert.ok(commitments.some((row) => row === "getTokenLargestAccounts:processed"));
  assert.equal(decision.ok, true);
  assert.ok(decision.pct !== null && Math.abs(decision.pct - 10) < 0.001);
});

test("Token-2022 holders from the program scan still skip above 25% after dropping the curve", async () => {
  const mint = Keypair.generate().publicKey;
  const curveAta = excludedHolderAccounts(mint)[2];
  assert.ok(curveAta);
  const wallet = Keypair.generate().publicKey.toBase58();
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "getAccountInfo") {
      return json({ jsonrpc: "2.0", id: 1, result: { value: { owner: TOKEN_2022 } } });
    }
    if (body.method === "getTokenLargestAccounts") {
      return json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "Invalid param: not a Token mint" },
      });
    }
    if (body.method === "getProgramAccounts") {
      return json({
        jsonrpc: "2.0",
        id: 1,
        result: [
          { pubkey: curveAta, account: { data: [amountB64(700_000n), "base64"] } },
          { pubkey: wallet, account: { data: [amountB64(300_000n), "base64"] } },
        ],
      });
    }
    if (body.method === "getTokenSupply") {
      return json({ jsonrpc: "2.0", id: 1, result: { value: { amount: "1000000" } } });
    }
    return json({ jsonrpc: "2.0", id: 1, error: { message: "unexpected" } });
  };
  let now = 0;
  const check = new RpcHolderCheck("https://rpc.example", 25, fetchImpl, new Logger(), {
    timeoutMs: 500,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const decision = await check.lookup(mint.toBase58());
  assert.equal(decision.ok, false);
  assert.match(decision.reason ?? "", /30\.00%/);
  assert.ok((decision.pct ?? 0) > 25);
});

test("an SPL mint uses the same processed retry and an unfinished check still skips", async () => {
  const mint = Keypair.generate().publicKey;
  let accounts = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "getAccountInfo") {
      accounts += 1;
      return json({ jsonrpc: "2.0", id: 1, result: { value: null } });
    }
    return json({ jsonrpc: "2.0", id: 1, error: { message: "unexpected" } });
  };
  let now = 0;
  const check = new RpcHolderCheck("https://rpc.example", 25, fetchImpl, new Logger(), {
    timeoutMs: 200,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const missing = await check.lookup(mint.toBase58());
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "top10-unavailable");
  assert.ok(accounts > 1);

  const spl = Keypair.generate().publicKey;
  const curveAta = excludedHolderAccounts(spl)[1];
  assert.ok(curveAta);
  const wallet = Keypair.generate().publicKey.toBase58();
  const ready: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const commitment = (body.params[1] as { commitment?: string } | undefined)?.commitment;
    if (body.method === "getTokenLargestAccounts") assert.equal(commitment, "processed");
    if (body.method === "getAccountInfo") {
      return json({ jsonrpc: "2.0", id: 1, result: { value: { owner: TOKEN_PROGRAM } } });
    }
    if (body.method === "getTokenLargestAccounts") {
      return json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          value: [
            { address: curveAta, amount: "500000" },
            { address: wallet, amount: "200000" },
          ],
        },
      });
    }
    if (body.method === "getTokenSupply") {
      return json({ jsonrpc: "2.0", id: 1, result: { value: { amount: "1000000" } } });
    }
    return json({ jsonrpc: "2.0", id: 1, error: { message: "unexpected" } });
  };
  const pass = new RpcHolderCheck("https://rpc.example", 25, ready, new Logger(), {
    timeoutMs: 200,
    now: () => 0,
    sleep: async () => {},
  });
  const decision = await pass.lookup(spl.toBase58());
  assert.equal(decision.ok, true);
  assert.ok(decision.pct !== null && Math.abs(decision.pct - 20) < 0.001);
});
