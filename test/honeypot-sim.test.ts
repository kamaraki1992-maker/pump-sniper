import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import {
  assessSellability,
  classifySellSimulation,
  createHoneypotCheck,
  creatorVaultPda,
  formatRpcError,
  honeypotDecision,
  PROBE_MAX_SOL_LAMPORTS,
  relaxProbeMaxSol,
  repairPumpAmmSell,
  repairPumpCreatorVault,
  sellExecuted,
  simulateRoundTrip,
  simulationErrorCode,
} from "../src/momentum/honeypot.js";

function localTx(): Uint8Array {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 })],
  }).compileToV0Message();
  return new VersionedTransaction(message).serialize();
}

function tradeFetch(bodies: Array<Record<string, unknown>>): typeof fetch {
  const bytes = localTx();
  return async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(Buffer.from(bytes));
  };
}

test("a curve round trip that sells is not a honeypot, and a PumpSwap mint uses pump-amm", async () => {
  const curveBodies: Array<Record<string, unknown>> = [];
  const curve = await assessSellability({
    mint: "CurveMint",
    pool: "pump",
    slippagePct: 15,
    tradeUrl: "https://trade.example/api/trade-local",
    tradeFetch: tradeFetch(curveBodies),
    simulate: async () => ({
      err: null,
      logs: [
        "Program log: Instruction: Sell",
        "Program log: Instruction: TransferChecked",
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
      ],
    }),
  });
  assert.equal(curve.result, "ok");
  assert.equal(honeypotDecision(curve.result).ok, true);
  assert.deepEqual(curveBodies.map((body) => body.pool), ["pump", "pump"]);
  assert.equal(curveBodies[0]?.action, "buy");
  assert.equal(curveBodies[1]?.action, "sell");

  const ammBodies: Array<Record<string, unknown>> = [];
  const amm = await assessSellability({
    mint: "AmmMint",
    pool: "pump-amm",
    slippagePct: 15,
    tradeUrl: "https://trade.example/api/trade-local",
    tradeFetch: tradeFetch(ammBodies),
    simulate: async () => ({
      err: null,
      logs: [
        "Program log: Instruction: Sell",
        "Program log: Instruction: TransferChecked",
        "Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA success",
      ],
    }),
  });
  assert.equal(amm.result, "ok");
  assert.equal(amm.pool, "pump-amm");
  assert.deepEqual(ammBodies.map((body) => body.pool), ["pump-amm", "pump-amm"]);
});

test("a reverting sell is a honeypot and a missing ATA is not", () => {
  const frozen = { InstructionError: [4, { Custom: 17 }] };
  assert.equal(simulationErrorCode(frozen), 17);
  assert.equal(classifySellSimulation(frozen, ["Program log: Account is frozen"]), "fail");
  assert.equal(honeypotDecision("fail", 17).reason, "honeypot_sim_error:17");
  const buyback = { InstructionError: [2, { Custom: 6053 }] };
  assert.equal(simulationErrorCode(buyback), 6053);
  assert.equal(classifySellSimulation(buyback, ["Program log: BuybackFeeRecipientNotAuthorized", "user_base_token_account"]), "fail");
  assert.equal(honeypotDecision("fail", 6053).ok, false);
  assert.equal(honeypotDecision("fail", 6053).reason, "honeypot_sim_error:6053");
  assert.equal(sellExecuted({ err: buyback, logs: ["Program log: Instruction: Sell"] }), false);

  const missing = { InstructionError: [3, { Custom: 3012 }] };
  const logs = ["Program log: AnchorError caused by account: associated_base_user. Error Code: AccountNotInitialized. Error Number: 3012."];
  assert.equal(classifySellSimulation(missing, logs), "no-balance");
  assert.equal(honeypotDecision("no-balance", 3012).ok, false);
  assert.equal(honeypotDecision("no-balance", 3012).reason, "honeypot_sim_error:3012");
  assert.equal(classifySellSimulation(null, ["TransferFee withheld"]), "transfer-fee");
});

test("a round trip that reverts is blocked, and a builder timeout stays fail-closed", async () => {
  const reverted = await assessSellability({
    mint: "Trap",
    pool: "pump",
    slippagePct: 15,
    tradeUrl: "https://trade.example/api/trade-local",
    tradeFetch: tradeFetch([]),
    simulate: async () => ({
      err: { InstructionError: [4, { Custom: 6000 }] },
      logs: ["Program log: AnchorError. Error Code: SellDisabled. Error Number: 6000."],
    }),
  });
  assert.equal(reverted.result, "fail");
  assert.equal(reverted.err, "6000");
  assert.match(reverted.log ?? "", /SellDisabled/);
  assert.equal(honeypotDecision(reverted.result, 6000).reason, "honeypot_sim_error:6000");
  assert.equal(honeypotDecision(reverted.result, 6000).ok, false);

  const dir = mkdtempSync(join(tmpdir(), "honeypot-"));
  const config = loadConfig({
    DATA_DIR: dir,
    KILL_FILE: join(dir, "KILL"),
    TRADE_API_URL: "https://trade.example/api/bundle",
    RPC_URL: "https://rpc.example",
  });
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("timed out");
  };
  try {
    const verdict = await createHoneypotCheck(config)("MintTimeout", "pump");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "honeypot_unsimulated");
    assert.match(verdict.simErr ?? "", /timed out/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("an RPC internal error is retried, and the buyback wallet is account 21", async () => {
  assert.equal(formatRpcError({ code: -32603, message: "Internal error", data: { err: "lookup table" } }), "-32603 Internal error {\"err\":\"lookup table\"}");
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { method?: string; params?: unknown[] };
    calls.push(`${url} ${body.method}`);
    if (String(url).includes("rug") && body.method === "simulateTransaction") {
      return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error", data: "flux rejected the round trip" } });
    }
    if (body.method === "getLatestBlockhash") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { value: { blockhash: "11111111111111111111111111111111" } } });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        value: {
          err: null,
          logs: [
            "Program log: Instruction: Sell",
            "Program log: Instruction: TransferChecked",
            "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
          ],
        },
      },
    });
  };
  const sim = await simulateRoundTrip(["https://rug.example", "https://rpc.example"], fetcher, tx);
  assert.equal(sim.err, null);
  assert.ok(calls.some((call) => call.includes("rug.example")));
  assert.ok(calls.some((call) => call.includes("rpc.example")));

  const program = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  const recipient = Keypair.generate().publicKey;
  const keys = Array.from({ length: 24 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }));
  const repaired = repairPumpAmmSell(new TransactionInstruction({ programId: program, keys, data: Buffer.from([1]) }), recipient);
  assert.equal(repaired.keys[21]?.pubkey.toBase58(), recipient.toBase58());
  assert.equal(repaired.keys[22]?.isWritable, true);
});

test("a stale creator_vault is rewritten, and 2006 stays a skip until the sell runs", async () => {
  const program = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  const creator = Keypair.generate().publicKey;
  const stale = Keypair.generate().publicKey;
  const staleVault = creatorVaultPda(stale);
  const expected = creatorVaultPda(creator);
  const keys = Array.from({ length: 20 }, () => ({
    pubkey: Keypair.generate().publicKey,
    isSigner: false,
    isWritable: false,
  }));
  keys[16] = { pubkey: staleVault, isSigner: false, isWritable: true };
  keys[18] = { pubkey: stale, isSigner: false, isWritable: false };
  const repaired = repairPumpCreatorVault(
    new TransactionInstruction({ programId: program, keys, data: Buffer.from([1]) }),
    creator,
  );
  assert.equal(repaired.keys[16]?.pubkey.toBase58(), expected.toBase58());
  assert.equal(repaired.keys[18]?.pubkey.toBase58(), creator.toBase58());

  const payer = Keypair.generate();
  const bytes = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [new TransactionInstruction({ programId: program, keys, data: Buffer.from([1]) })],
  }).compileToV0Message()).serialize();
  const tradeFetch: typeof fetch = async () => new Response(Buffer.from(bytes));
  const sold = {
    err: null,
    logs: [
      "Program log: Instruction: Sell",
      "Program log: Instruction: TransferChecked",
      "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
    ],
  };
  const broken = { err: { InstructionError: [1, { Custom: 2006 }] }, logs: ["Program log: ConstraintSeeds"] };
  const simulate = async (tx: VersionedTransaction) => {
    const present = tx.message.staticAccountKeys.some((key) => key.equals(expected));
    return present ? sold : broken;
  };
  const fixed = await assessSellability({
    mint: Keypair.generate().publicKey.toBase58(),
    pool: "pump",
    slippagePct: 15,
    tradeUrl: "https://trade.example/api/trade-local",
    tradeFetch,
    simulate,
    loadCurveCreator: async () => creator,
  });
  assert.equal(fixed.result, "ok");
  assert.equal(honeypotDecision(fixed.result).ok, true);
  const raw = await assessSellability({
    mint: Keypair.generate().publicKey.toBase58(),
    pool: "pump",
    slippagePct: 15,
    tradeUrl: "https://trade.example/api/trade-local",
    tradeFetch,
    simulate,
  });
  assert.equal(raw.result, "fail");
  assert.equal(raw.err, "2006");
  assert.equal(honeypotDecision(raw.result, 2006).ok, false);
  assert.equal(honeypotDecision(raw.result, 2006).reason, "honeypot_sim_error:2006");
});

test("a 429 is retried inside the sim budget and then fails closed", async () => {
  const payer = Keypair.generate();
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 })],
  }).compileToV0Message());
  let calls = 0;
  const started = Date.now();
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method?: string };
    if (body.method === "getLatestBlockhash") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { value: { blockhash: "11111111111111111111111111111111" } } });
    }
    calls += 1;
    if (calls < 3) return new Response("rate limit exceeded", { status: 429 });
    return Response.json({ jsonrpc: "2.0", id: 1, result: { value: { err: null, logs: [] } } });
  };
  const sim = await simulateRoundTrip(["https://rpc.example"], fetcher, tx, Date.now() + 5_000);
  assert.equal(sim.err, null);
  assert.equal(sim.attempt, "first pass");
  assert.equal(calls, 3);
  assert.ok(Date.now() - started >= 500);

  const tightStart = Date.now();
  let tightCalls = 0;
  const tightFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method?: string };
    if (body.method !== "simulateTransaction") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { value: null } });
    }
    tightCalls += 1;
    return new Response("429 rate limit exceeded", { status: 429 });
  };
  await assert.rejects(() => simulateRoundTrip(["https://rpc.example"], tightFetch, tx, Date.now() + 50));
  assert.equal(tightCalls, 1);
  assert.ok(Date.now() - tightStart < 250);
});

test("a probe buy_v2 raises max_sol_cost, and a remaining 6002 still fails closed", async () => {
  const program = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  const data = Buffer.alloc(24);
  data.set([184, 23, 238, 97, 103, 197, 211, 61], 0);
  data.writeBigUInt64LE(1n, 8);
  data.writeBigUInt64LE(1_000n, 16);
  const ix = new TransactionInstruction({
    programId: program,
    keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }],
    data,
  });
  assert.equal(relaxProbeMaxSol(ix).data.readBigUInt64LE(16), PROBE_MAX_SOL_LAMPORTS);
  const payer = Keypair.generate();
  const bytes = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [ix],
  }).compileToV0Message()).serialize();
  const sellLogs = [
    "Program log: Instruction: Sell",
    "Program log: Instruction: TransferChecked",
    "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
  ];
  const tooMuch = { InstructionError: [1, { Custom: 6002 }] };
  let fetches = 0;
  const caps: bigint[] = [];
  const tradeFetch: typeof fetch = async () => {
    fetches += 1;
    return new Response(Buffer.from(bytes));
  };
  let sims = 0;
  const held = await assessSellability({
    mint: "Mint",
    pool: "pump",
    slippagePct: 15,
    tradeUrl: "https://trade.example/api/trade-local",
    tradeFetch,
    simulate: async (tx) => {
      sims += 1;
      const decoded = TransactionMessage.decompile(tx.message).instructions;
      const buy = decoded.find((row) => row.data.length >= 24 && row.data[0] === 184);
      caps.push(buy ? Buffer.from(buy.data).readBigUInt64LE(16) : 0n);
      return { err: tooMuch, logs: ["TooMuchSolRequired"] };
    },
  });
  assert.equal(held.result, "fail");
  assert.equal(held.err, "6002");
  assert.equal(honeypotDecision(held.result, 6002).reason, "honeypot_sim_error:6002");
  assert.equal(sims, 2);
  assert.equal(fetches, 4);
  assert.deepEqual(caps, [PROBE_MAX_SOL_LAMPORTS, PROBE_MAX_SOL_LAMPORTS]);

  sims = 0;
  const recovered = await assessSellability({
    mint: "Mint",
    pool: "pump",
    slippagePct: 15,
    tradeUrl: "https://trade.example/api/trade-local",
    tradeFetch,
    simulate: async () => {
      sims += 1;
      if (sims === 1) return { err: tooMuch, logs: ["TooMuchSolRequired"] };
      return { err: null, logs: sellLogs };
    },
  });
  assert.equal(recovered.result, "ok");
  assert.equal(sims, 2);
});
