import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import {
  assessSellability,
  classifySellSimulation,
  createHoneypotCheck,
  honeypotDecision,
  sellExecuted,
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
  } finally {
    globalThis.fetch = previous;
  }
});
