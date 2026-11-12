import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { cuLimitFromConsumed, JITO_TIP_ACCOUNTS, microLamportsForFee } from "../src/compute.js";
import type { PaperModel } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { PaperExecutor } from "../src/executor-paper.js";
import { LiveExecutor, type LivePorts } from "../src/executor-live.js";
import {
  clampMicroLamports,
  highPercentile,
  PriorityFeeEstimator,
} from "../src/priority-fee.js";

const model: PaperModel = {
  slippagePct: 0,
  protocolFeeBps: 0,
  venueFeeBps: 0,
  priorityFeeSol: 0.00005,
  baseFeeSol: 0.000005,
  jitoTipSol: 0.002,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("the priority fee clamp keeps the total at or under the lamport cap", () => {
  const cu = 200_000;
  const capped = clampMicroLamports(50_000_000, cu, 500_000);
  const total = Math.floor((capped * cu) / 1_000_000);
  assert.equal(total, 500_000);
  assert.ok(total <= 500_000);
  assert.equal(highPercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test("Helius High is used, cached, and clamped", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: Array<{ options?: { priorityLevel?: string }; accountKeys?: string[] }>;
    };
    assert.equal(body.method, "getPriorityFeeEstimate");
    assert.equal(body.params[0]?.options?.priorityLevel, "High");
    assert.deepEqual(body.params[0]?.accountKeys, ["Mint"]);
    return json({ jsonrpc: "2.0", id: 1, result: { priorityFeeEstimate: 50_000_000 } });
  };
  const estimator = new PriorityFeeEstimator("https://rpc.example", 0.00005, 500_000, 5_000, fetchImpl, () => 1_000);
  const first = await estimator.quote(["Mint"], 200_000);
  const second = await estimator.quote(["Mint"], 200_000);
  assert.equal(calls, 1);
  assert.equal(first.source, "helius");
  assert.equal(first.totalLamports, 500_000);
  assert.equal(first.sol, 0.0005);
  assert.equal(second.sol, first.sol);
});

test("Helius Medium is clamped to the momentum cap and does not reuse a High quote", async () => {
  const levels: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: Array<{ options?: { priorityLevel?: string } }>;
    };
    levels.push(body.params[0]?.options?.priorityLevel ?? "");
    const micro = body.params[0]?.options?.priorityLevel === "Medium" ? 5_000_000 : 80_000_000;
    return json({ jsonrpc: "2.0", id: 1, result: { priorityFeeEstimate: micro } });
  };
  const estimator = new PriorityFeeEstimator("https://rpc.example", 0.00005, 500_000, 0, fetchImpl, () => 1_000);
  const medium = await estimator.quote(["Mint"], 200_000, { level: "Medium", maxLamports: 50_000 });
  const high = await estimator.quote(["Mint"], 200_000, { level: "High", maxLamports: 200_000 });
  assert.deepEqual(levels, ["Medium", "High"]);
  assert.equal(medium.totalLamports, 50_000);
  assert.equal(medium.sol, 0.00005);
  assert.equal(high.totalLamports, 200_000);
  assert.equal(high.sol, 0.0002);
});

test("a missing Helius estimate uses the 90th percentile, then the SOL fallback", async () => {
  const recentFees = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000];
  let mode: "recent" | "down" = "recent";
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "getPriorityFeeEstimate") {
      return json({ jsonrpc: "2.0", id: 1, error: { message: "method not found" } });
    }
    if (mode === "down") return json({ jsonrpc: "2.0", id: 1, error: { message: "rpc down" } });
    return json({
      jsonrpc: "2.0",
      id: 1,
      result: recentFees.map((fee, slot) => ({ slot, prioritizationFee: fee })),
    });
  };
  const recent = new PriorityFeeEstimator("https://rpc.example", 0.00005, 500_000, 0, fetchImpl, () => 0);
  const quoted = await recent.quote(["Mint"], 100_000);
  assert.equal(quoted.source, "recent");
  assert.equal(quoted.microLamports, 900);
  const total = Math.floor((900 * 100_000) / 1_000_000);
  assert.equal(quoted.totalLamports, total);
  assert.ok(quoted.totalLamports <= 500_000);

  mode = "down";
  const failed = new PriorityFeeEstimator("https://rpc.example", 0.00005, 500_000, 0, fetchImpl, () => 0);
  const fallback = await failed.quote(["Mint"], cuLimitFromConsumed(null));
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.sol, 0.00005);
  assert.equal(fallback.microLamports, microLamportsForFee(0.00005, cuLimitFromConsumed(null)));
});

test("paper PnL uses the estimated fee and falls back when the quote throws", async () => {
  const order = {
    mint: "M",
    name: "N",
    symbol: "S",
    creator: "C",
    sizeSol: 0.1,
    quotePriceSol: 0.00000004,
    slippagePct: 5,
    reason: "entry" as const,
  };
  const estimated = new PaperExecutor(model, async () => 0.0005);
  const filled = await estimated.buy(order);
  assert.ok(Math.abs(filled.cashflowSol - (0.1 + 0.0005 + 0.000005 + 0.002)) < 1e-12);
  assert.ok(filled.feesSol > model.priorityFeeSol);

  const broken = new PaperExecutor(model, async () => {
    throw new Error("rpc down");
  });
  const fallback = await broken.buy(order);
  assert.ok(Math.abs(fallback.cashflowSol - (0.1 + 0.00005 + 0.000005 + 0.002)) < 1e-12);
});

test("the config default clamp is about 0.0005 SOL", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.priorityFeeMaxLamports, 500_000);
  assert.equal(cfg.priorityFeeCacheMs, 5_000);
  assert.equal(cfg.priorityFeeSol, 0.00005);
});

test("live bundles write the quoted priority fee into the compute budget", async () => {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })],
  }).compileToV0Message();
  const raw = new VersionedTransaction(message).serialize();
  let price = 0;
  const config = loadConfig({});
  const ports: LivePorts = {
    publicKey: payer.publicKey,
    config,
    tipAccount: new PublicKey(JITO_TIP_ACCOUNTS[0]),
    sign: (tx) => tx.sign([payer]),
    buildUnsignedTx: async () => raw,
    simulate: async () => ({ unitsConsumed: 80_000, err: null }),
    lookupTables: async () => [],
    priorityFee: async () => 0.0004,
    sendBundle: async (tx) => {
      price = readComputeUnitPrice(tx);
      return { bundleId: "bundle", signature: bs58.encode(tx.signatures[0] ?? new Uint8Array()) };
    },
    confirm: async () => ({ state: "landed", solDelta: -0.2 }),
  };
  const result = await new LiveExecutor(ports).buy({
    mint: "Mint111",
    name: "Name",
    symbol: "SYM",
    creator: "Creator",
    sizeSol: 0.1,
    quotePriceSol: 1,
    slippagePct: 5,
    reason: "entry",
  });
  assert.equal(result.status, "filled");
  const expected = microLamportsForFee(0.0004, cuLimitFromConsumed(80_000));
  assert.equal(price, expected);
});

function readComputeUnitPrice(tx: VersionedTransaction): number {
  for (const ix of tx.message.compiledInstructions) {
    const program = tx.message.staticAccountKeys[ix.programIdIndex];
    if (!program?.equals(ComputeBudgetProgram.programId)) continue;
    if (ix.data.length !== 9 || ix.data[0] !== 3) continue;
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    return Number(view.getBigUint64(1, true));
  }
  return 0;
}
