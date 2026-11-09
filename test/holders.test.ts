import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { bondingCurveAddress } from "../src/curve-watch.js";
import {
  excludedHolderAccounts,
  readLargestAccounts,
  readSupplyAmount,
  top10Decision,
  type LargestAccount,
} from "../src/holders.js";

test("top 10 excludes the bonding curve, its token account, and the pump pool", () => {
  const mint = Keypair.generate().publicKey;
  const excludeList = excludedHolderAccounts(mint);
  const exclude = new Set(excludeList);
  const curve = bondingCurveAddress(mint.toBase58(), null);
  assert.ok(curve);
  assert.ok(exclude.has(curve));
  assert.ok(excludeList.length >= 6);

  const curveAta = excludeList[1];
  const poolAta = excludeList[4];
  assert.ok(curveAta);
  assert.ok(poolAta);
  assert.notEqual(curveAta, curve);
  const supply = 1_000_000n;
  const wallets: LargestAccount[] = [];
  for (let i = 0; i < 10; i += 1) {
    wallets.push({ address: Keypair.generate().publicKey.toBase58(), amount: 20_000n });
  }
  const accounts: LargestAccount[] = [
    { address: curveAta, amount: 400_000n },
    { address: poolAta, amount: 300_000n },
    { address: curve, amount: 50_000n },
    ...wallets,
  ];

  const filtered = top10Decision(accounts, supply, exclude, 25);
  assert.equal(filtered.ok, true);
  assert.ok(filtered.pct !== null && Math.abs(filtered.pct - 20) < 0.001);

  const raw = top10Decision(accounts, supply, new Set(), 25);
  assert.equal(raw.ok, false);
  assert.match(raw.reason ?? "", /89\.00%/);
  assert.equal(raw.pct, 89);

  const heavy = top10Decision(
    [...wallets.map((row, index) => (index === 0 ? { ...row, amount: 80_000n } : row)), { address: curveAta, amount: 100_000n }],
    supply,
    exclude,
    25,
  );
  assert.equal(heavy.ok, false);
  assert.match(heavy.reason ?? "", /26\.00%/);
  assert.ok((heavy.pct ?? 0) > 25);

  const exact = top10Decision(
    wallets.map((row) => ({ ...row, amount: 25_000n })),
    supply,
    exclude,
    25,
  );
  assert.equal(exact.ok, true);
  assert.equal(exact.pct, 25);
});

test("largest-account and supply payloads unwrap the value field", () => {
  const rows = readLargestAccounts({
    context: { slot: 1 },
    value: [
      { address: "A", amount: "1000", decimals: 6, uiAmount: 0.001 },
      { address: "B", amount: "bad" },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.address, "A");
  assert.equal(rows[0]?.amount, 1000n);
  assert.equal(readSupplyAmount({ value: { amount: "1000000", decimals: 6 } }), 1_000_000n);
  assert.equal(readSupplyAmount({}), null);
  assert.equal(top10Decision([], 0n, new Set(), 25).reason, "top10-unavailable");
});

test("an unrelated pubkey is not treated as the curve", () => {
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const exclude = excludedHolderAccounts(mint);
  assert.equal(new Set(exclude).size, exclude.length);
});
