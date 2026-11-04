import assert from "node:assert/strict";
import { test } from "node:test";
import {
  curveRoundTrip,
  EXT_TRANSFER_FEE_CONFIG,
  EXT_TRANSFER_HOOK,
  inspectMintAccount,
  runSafetyCheck,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../src/safety.js";

function mintData(options: { mintAuth?: boolean; freeze?: boolean; extension?: number }): Uint8Array {
  const data = Buffer.alloc(options.extension === undefined ? 82 : 200);
  data.writeUInt32LE(options.mintAuth ? 1 : 0, 0);
  data.writeUInt32LE(options.freeze ? 1 : 0, 46);
  if (options.extension !== undefined) {
    data.writeUInt16LE(options.extension, 166);
    data.writeUInt16LE(0, 168);
  }
  return data;
}

test("mint and freeze authorities and token-2022 transfer extensions are rejected", () => {
  assert.equal(inspectMintAccount(TOKEN_PROGRAM_ID, mintData({})).ok, true);
  assert.equal(inspectMintAccount(TOKEN_PROGRAM_ID, mintData({ mintAuth: true })).reason, "mint-authority-set");
  assert.equal(inspectMintAccount(TOKEN_PROGRAM_ID, mintData({ freeze: true })).reason, "freeze-authority-set");
  assert.equal(inspectMintAccount("11111111111111111111111111111111", mintData({})).reason, "unsupported-token-program");
  assert.equal(
    inspectMintAccount(TOKEN_2022_PROGRAM_ID, mintData({ extension: EXT_TRANSFER_FEE_CONFIG })).reason,
    "transfer-fee",
  );
  assert.equal(
    inspectMintAccount(TOKEN_2022_PROGRAM_ID, mintData({ extension: EXT_TRANSFER_HOOK })).reason,
    "transfer-hook",
  );
  assert.equal(inspectMintAccount(TOKEN_2022_PROGRAM_ID, mintData({ extension: 3 })).ok, true);
});

test("a safety check that exceeds its budget is skipped", async () => {
  const result = await runSafetyCheck(
    () => new Promise(() => {}),
    30,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "safety_timeout");
  assert.ok(result.latencyMs >= 30);
});

test("curve round trip fails closed on empty reserves", () => {
  assert.equal(curveRoundTrip(30, 1_000_000_000, 0.1).ok, true);
  assert.equal(curveRoundTrip(0, 1, 0.1).ok, false);
});
