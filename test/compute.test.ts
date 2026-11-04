import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  cuLimitFromConsumed,
  JITO_TIP_ACCOUNTS,
  microLamportsForFee,
  pickTipAccount,
  tipLamports,
  withComputeBudgetAndTip,
} from "../src/compute.js";

test("compute limit pads the simulation and the tip converts inside the hard bounds", () => {
  assert.equal(cuLimitFromConsumed(100_000), Math.ceil(100_000 * 1.2) + 10_000);
  assert.equal(cuLimitFromConsumed(null), Math.ceil(200_000 * 1.2) + 10_000);
  assert.equal(tipLamports(0.002), 2_000_000);
  assert.equal(tipLamports(0.005), 5_000_000);
  const limit = cuLimitFromConsumed(100_000);
  const micro = microLamportsForFee(0.00005, limit);
  const lamports = Math.floor((micro * limit) / 1_000_000);
  assert.ok(Math.abs(lamports - 50_000) < 2);
});

test("rewrite installs a compute budget and exactly one Jito tip", () => {
  const payer = Keypair.generate().publicKey;
  const tip = new PublicKey(JITO_TIP_ACCOUNTS[0]);
  const other = SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 });
  const existingTip = SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: new PublicKey(JITO_TIP_ACCOUNTS[1]),
    lamports: 9,
  });
  const next = withComputeBudgetAndTip([existingTip, other], {
    cuLimit: 120_000,
    microLamports: 1_000,
    tipLamports: 2_000_000,
    tipAccount: tip,
    payer,
  });
  const programs = next.map((ix: TransactionInstruction) => ix.programId.toBase58());
  assert.equal(programs.filter((id) => id === ComputeBudgetProgram.programId.toBase58()).length, 2);
  const tips = next.filter((ix) => ix.keys[1]?.pubkey.toBase58() === tip.toBase58());
  assert.equal(tips.length, 1);
  assert.equal(pickTipAccount(() => 0).toBase58(), JITO_TIP_ACCOUNTS[0]);

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: next,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  assert.ok(tx.message.compiledInstructions.length >= 3);
});
