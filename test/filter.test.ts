import assert from "node:assert/strict";
import { test } from "node:test";
import { historyDecision, holdDecision, marketCapSolFromCurveData, type HistoryTx } from "../src/filter.js";
import { multipleAccounts } from "../src/history.js";

function tx(partial: Partial<HistoryTx> & Pick<HistoryTx, "blockTimeSec">): HistoryTx {
  return {
    logs: [],
    createdMint: null,
    balances: [],
    ...partial,
  };
}

test("creator must hold under 10% of supply at launch", () => {
  assert.equal(holdDecision(99_999_999, 10).ok, true);
  const atCap = holdDecision(100_000_000, 10);
  assert.equal(atCap.ok, false);
  assert.match(atCap.reason ?? "", /10\.00%/);
  assert.equal(holdDecision(0, 10).ok, true);
  assert.equal(holdDecision(Number.NaN, 10).ok, false);
});

test("a creator who sold most of the launch allocation early is skipped", () => {
  const decision = historyDecision(
    [
      tx({
        blockTimeSec: 1_000,
        logs: ["Program log: Instruction: CreateV2"],
        createdMint: "MintDump",
      }),
      tx({
        blockTimeSec: 1_010,
        logs: ["Program log: Instruction: BuyV2"],
        balances: [{ mint: "MintDump", preUi: 0, postUi: 1_000_000 }],
      }),
      tx({
        blockTimeSec: 1_040,
        logs: ["Program log: Instruction: SellV2"],
        balances: [{ mint: "MintDump", preUi: 1_000_000, postUi: 100_000 }],
      }),
    ],
    [],
    2_000,
  );
  assert.equal(decision.ok, false);
  assert.match(decision.reason ?? "", /creator-dev-dump/);
});

test("selling exactly half is not treated as selling most", () => {
  const decision = historyDecision(
    [
      tx({
        blockTimeSec: 1_000,
        logs: ["Program log: Instruction: CreateV2"],
        createdMint: "MintHalf",
      }),
      tx({
        blockTimeSec: 1_010,
        balances: [{ mint: "MintHalf", preUi: 0, postUi: 1_000 }],
      }),
      tx({
        blockTimeSec: 1_050,
        balances: [{ mint: "MintHalf", preUi: 1_000, postUi: 500 }],
      }),
    ],
    [],
    2_000,
  );
  assert.equal(decision.ok, true);
});

test("a clean creator with no prior sell is accepted", () => {
  const decision = historyDecision(
    [
      tx({
        blockTimeSec: 1_000,
        logs: ["Program log: Instruction: Create"],
        createdMint: "MintOk",
      }),
      tx({
        blockTimeSec: 1_020,
        balances: [{ mint: "MintOk", preUi: 0, postUi: 2_000_000 }],
      }),
    ],
    [],
    1_500,
  );
  assert.equal(decision.ok, true);
});

test("a prior coin back at the curve floor after the creator left is a rug", () => {
  const created = 10_000;
  const decision = historyDecision(
    [
      tx({
        blockTimeSec: created,
        logs: ["Program log: Instruction: CreateV2"],
        createdMint: "MintRug",
      }),
      tx({
        blockTimeSec: created + 20,
        balances: [{ mint: "MintRug", preUi: 0, postUi: 5_000_000 }],
      }),
      tx({
        blockTimeSec: created + 2_000,
        logs: ["Program log: Instruction: SellV2"],
        balances: [{ mint: "MintRug", preUi: 5_000_000, postUi: 0 }],
      }),
    ],
    [{ mint: "MintRug", marketCapSol: 28 }],
    created + 4_000,
  );
  assert.equal(decision.ok, false);
  assert.match(decision.reason ?? "", /creator-rug/);
});

test("getMultipleAccounts result is the value array", () => {
  const wrapped = multipleAccounts({ context: { slot: 1 }, value: [{ data: ["abc", "base64"] }, null] });
  assert.equal(wrapped.length, 2);
  assert.equal(wrapped[0]?.data?.[0], "abc");
  assert.equal(multipleAccounts([{ data: ["z", "base64"] }]).length, 1);
  assert.deepEqual(multipleAccounts(null), []);
});

test("curve market cap uses virtual reserves at the documented offsets", () => {
  const data = Buffer.alloc(48);
  data.writeBigUInt64LE(1_070_395_218_751_065n, 8);
  data.writeBigUInt64LE(31_770_046_797n, 16);
  const mc = marketCapSolFromCurveData(data);
  assert.ok(mc !== null && mc > 29 && mc < 30);
});
