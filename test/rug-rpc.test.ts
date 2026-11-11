import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { RpcHolderCheck } from "../src/holders.js";
import { Logger } from "../src/logger.js";
import { rpcHost } from "../src/redact.js";
import { createRpcSafetyCheck, TOKEN_PROGRAM_ID } from "../src/safety.js";

const SECRET = "supersecretkey123";
const RUG = `https://rug.example/rpc?api-key=${SECRET}`;
const MAIN = "https://main.example/rpc";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("rug check RPC falls back to RPC_URL and otherwise stays separate", () => {
  const fallback = loadConfig({ RPC_URL: MAIN });
  assert.equal(fallback.rugCheckRpcUrl, MAIN);
  assert.equal(fallback.rpcUrl, MAIN);
  const blank = loadConfig({ RPC_URL: MAIN, RUG_CHECK_RPC_URL: "  " });
  assert.equal(blank.rugCheckRpcUrl, MAIN);
  const dedicated = loadConfig({ RPC_URL: MAIN, RUG_CHECK_RPC_URL: RUG });
  assert.equal(dedicated.rpcUrl, MAIN);
  assert.equal(dedicated.rugCheckRpcUrl, RUG);
});

test("startup logs only the rug-check host", () => {
  const line = new Logger().format("info", "rug check rpc", { host: rpcHost(RUG) });
  const parsed = JSON.parse(line) as { host?: string };
  assert.equal(parsed.host, "rug.example");
  assert.equal(line.includes(SECRET), false);
  assert.equal(line.includes("api-key"), false);
});

test("holders use the dedicated RPC and the key never reaches the log", async () => {
  const urls: string[] = [];
  const mint = Keypair.generate().publicKey.toBase58();
  const lines: string[] = [];
  const log = new Logger([SECRET]);
  log.info = (message, fields) => {
    lines.push(log.format("info", message, fields));
  };
  const ok: typeof fetch = async (url, init) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body)) as { method: string };
    assert.equal(body.method, "getAccountInfo");
    return json({
      jsonrpc: "2.0",
      id: 1,
      result: { value: { owner: "11111111111111111111111111111111" } },
    });
  };
  const check = new RpcHolderCheck(RUG, 25, ok, log, { timeoutMs: 1_000, now: () => 0 });
  const decision = await check.lookup(mint);
  assert.equal(decision.ok, false);
  assert.deepEqual(urls, [RUG]);

  const failing: typeof fetch = async () => {
    throw new Error(`request failed ${RUG}`);
  };
  const failed = new RpcHolderCheck(RUG, 25, failing, log, {
    timeoutMs: 1,
    now: () => 0,
    sleep: async () => {},
  });
  await failed.lookup(mint);
  const text = lines.join("\n");
  assert.equal(text.includes(SECRET), false);
  assert.match(text, /api-key=\[REDACTED\]/);
});

test("mint authority uses the rug RPC and trade simulation stays on RPC_URL", async () => {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 0,
      }),
    ],
  }).compileToV0Message();
  const bytes = new VersionedTransaction(message).serialize();
  const mintData = Buffer.alloc(82).toString("base64");
  const calls: Array<{ url: string; method: string }> = [];
  const rpcFetch: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { method?: string };
    const method = body.method ?? "unknown";
    calls.push({ url: String(url), method });
    if (method === "getAccountInfo") {
      return json({
        jsonrpc: "2.0",
        id: 1,
        result: { value: { owner: TOKEN_PROGRAM_ID, data: [mintData, "base64"] } },
      });
    }
    return json({
      jsonrpc: "2.0",
      id: 1,
      result: { context: { slot: 1 }, value: { err: null, logs: [] } },
    });
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (!url.includes("/api/trade-local")) throw new Error(`unexpected fetch ${url}`);
    return new Response(Buffer.from(bytes));
  };
  try {
    const config = loadConfig({
      DATA_DIR: "/tmp/rug-rpc-safety",
      RPC_URL: MAIN,
      RUG_CHECK_RPC_URL: RUG,
      TRADE_API_URL: "https://trade.example/api/bundle",
    });
    const check = createRpcSafetyCheck(config, rpcFetch);
    await check({
      mint: Keypair.generate().publicKey.toBase58(),
      vSol: 30,
      vTokens: 1_000_000_000,
      spendSol: 0.1,
    }).catch(() => undefined);
  } finally {
    globalThis.fetch = original;
  }
  const mintReads = calls.filter((call) => call.method === "getAccountInfo");
  const simulations = calls.filter((call) => call.method === "simulateTransaction");
  assert.ok(mintReads.length >= 1);
  assert.ok(simulations.length >= 1);
  assert.ok(mintReads.every((call) => call.url === RUG));
  assert.ok(simulations.every((call) => call.url === MAIN));
  assert.equal(calls.some((call) => call.url.includes(SECRET)), true);
  assert.ok(mintReads.every((call) => call.url.includes(SECRET)));
});
