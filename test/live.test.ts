import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { buildBundleBody, parseBundleTransaction } from "../src/bundle-api.js";
import { JITO_TIP_ACCOUNTS } from "../src/compute.js";
import { loadConfig } from "../src/config.js";
import { LiveExecutor, liveFillFromConfirm, type LivePorts } from "../src/executor-live.js";
import type { OrderRequest } from "../src/types.js";

function order(): OrderRequest {
  return {
    mint: "Mint111",
    name: "Name",
    symbol: "SYM",
    creator: "Creator111",
    sizeSol: 0.1,
    quotePriceSol: 0.00000003,
    slippagePct: 20,
    reason: "entry",
  };
}

function unsigned(payer: PublicKey): Uint8Array {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message).serialize();
}

function ports(over: Partial<LivePorts> = {}): { ports: LivePorts; sent(): number } {
  const payer = Keypair.generate();
  let sent = 0;
  const config = loadConfig({});
  const base: LivePorts = {
    publicKey: payer.publicKey,
    config,
    tipAccount: new PublicKey(JITO_TIP_ACCOUNTS[0]),
    sign: (tx) => tx.sign([payer]),
    buildUnsignedTx: async () => unsigned(payer.publicKey),
    simulate: async () => ({ unitsConsumed: 80_000, err: null }),
    lookupTables: async () => [],
    sendBundle: async (tx) => {
      sent += 1;
      return { bundleId: "bundle", signature: bs58.encode(tx.signatures[0] ?? new Uint8Array()) };
    },
    confirm: async () => ({ state: "expired" }),
    ...over,
  };
  return { ports: base, sent: () => sent };
}

test("bundle body matches the Lightning trade fields and omits the private key", () => {
  const config = loadConfig({ JITO_TIP_SOL: "0.003" });
  const body = buildBundleBody("Pubkey111", order(), config);
  assert.equal(body.mint, "Mint111");
  assert.equal(body.jitoTip, 0.003);
  assert.equal(body.slippage, 20);
  assert.equal(body.accounts[0]?.type, "buy");
  assert.equal(body.accounts[0]?.amount, 0.1);
  assert.equal(body.accounts[0]?.denominatedInSol, "true");
  assert.equal(body.accounts[0]?.creator, "Creator111");
  assert.equal(JSON.stringify(body).includes("PRIVATE"), false);

  const sell = buildBundleBody("Pubkey111", { ...order(), reason: "tp" }, config);
  assert.equal(sell.accounts[0]?.type, "sell");
  assert.equal(sell.accounts[0]?.amount, "100%");
});

test("a base58 bundle payload decodes", () => {
  const bytes = unsigned(Keypair.generate().publicKey);
  const decoded = parseBundleTransaction({
    transactions: [{ transaction: bs58.encode(bytes), type: "buy" }],
  });
  assert.equal(Buffer.from(decoded).equals(Buffer.from(bytes)), true);
  assert.throws(() => parseBundleTransaction({ error: "slippage" }), /slippage/);
});

test("simulation slippage and an expired bundle are failed, not positions", async () => {
  const blocked = ports({
    simulate: async () => ({ unitsConsumed: 10, err: "Slippage tolerance exceeded" }),
  });
  const executor = new LiveExecutor(blocked.ports);
  const missed = await executor.buy(order());
  assert.equal(missed.status, "failed");
  assert.match(missed.error ?? "", /slippage-exceeded/);
  assert.equal(blocked.sent(), 0);

  const expiredPorts = ports();
  const expired = new LiveExecutor(expiredPorts.ports);
  const dropped = await expired.buy(order());
  assert.equal(dropped.status, "failed");
  assert.equal(dropped.error, "bundle-not-landed");
  assert.notEqual(dropped.signature, "paper");
  assert.ok(dropped.signature.length > 0);
});

test("a landed sell uses the wallet SOL delta when the chain reports one", () => {
  const result = liveFillFromConfirm(
    { ...order(), reason: "tp", tokenAmount: 10 },
    "sig",
    { state: "landed", solDelta: 0.18 },
    { price: 1, tokenAmount: 10, feesSol: 0.001, tipSol: 0.002, cashflowSol: 0 },
  );
  assert.equal(result.status, "filled");
  assert.equal(result.cashflowSol, 0.18);
  assert.equal(result.solscan, "https://solscan.io/tx/sig");
});
