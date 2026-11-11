import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Logger } from "../src/logger.js";
import { redact, redactRpcUrl } from "../src/redact.js";
import { TradeLog } from "../src/report.js";
import type { TradeRecord } from "../src/types.js";

test("the private key is removed from logs, errors, and the trade report", () => {
  const secret = bs58.encode(Keypair.generate().secretKey);
  const signature = bs58.encode(Keypair.generate().secretKey);
  const leaked = new Error(`sign failed for ${secret}`);
  const stack = `${leaked.stack ?? leaked.message}\nprivateKey":"${secret}"`;
  const cleaned = redact(stack, [secret]);
  assert.equal(cleaned.includes(secret), false);
  assert.match(cleaned, /\[REDACTED\]/);
  assert.ok(cleaned.includes(signature) || !stack.includes(signature));

  const withSignature = redact(`sent ${signature} key ${secret}`, [secret]);
  assert.equal(withSignature.includes(secret), false);
  assert.ok(withSignature.includes(signature));

  const logger = new Logger([secret]);
  const line = logger.format("error", "wallet failed", { detail: secret, signature });
  assert.equal(line.includes(secret), false);
  assert.ok(line.includes(signature));

  const dir = mkdtempSync(join(tmpdir(), "sniper-redact-"));
  const log = new TradeLog(join(dir, "trades.jsonl"), [secret]);
  const record: TradeRecord = {
    timestamp: "2026-11-04T12:00:00.000Z",
    mode: "paper",
    side: "buy",
    status: "failed",
    mint: "Mint",
    name: "Name",
    symbol: "SYM",
    sizeSol: 0.1,
    price: 0,
    feesSol: 0,
    jitoTipSol: 0,
    signature: "paper",
    solscan: null,
    reason: "entry",
    error: `rpc said ${secret}`,
    solUsd: 100,
    tokenAmount: 0,
    realizedPnlSol: null,
    costSol: null,
  };
  log.append(record);
  const stored = log.readAll();
  assert.equal(JSON.stringify(stored).includes(secret), false);
  assert.match(stored[0]?.error ?? "", /\[REDACTED\]/);
});

test("key query values are stripped the same way as api-key", () => {
  const url = "wss://pumpdev.io/ws?key=pumpdev-test-key-value";
  const cleaned = redactRpcUrl(`connect ${url}`);
  assert.equal(cleaned.includes("pumpdev-test-key-value"), false);
  assert.match(cleaned, /key=\[REDACTED\]/);
  const rpc = redactRpcUrl("wss://mainnet.helius-rpc.com/?api-key=supersecretkey123");
  assert.equal(rpc.includes("supersecretkey123"), false);
  assert.match(rpc, /api-key=\[REDACTED\]/);
});
