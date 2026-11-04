import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsFromGeyserLogs } from "../src/yellowstone.js";

test("geyser logs become a launch or a trade without inventing a price", () => {
  const launch = eventsFromGeyserLogs({
    signature: "sig",
    logs: ["Program log: Instruction: CreateV2"],
    balances: [{ mint: "Mintpump", uiAmount: 1_000_000_000 }, { mint: "So11111111111111111111111111111111111111112", uiAmount: 30 }],
  });
  assert.equal(launch[0]?.kind, "launch");
  assert.equal(launch[0] && "priceSol" in launch[0] ? launch[0].priceSol : null, null);

  const sell = eventsFromGeyserLogs({
    signature: "sig2",
    logs: ["Program log: Instruction: SellV2"],
    balances: [{ mint: "Mintpump", uiAmount: 10 }],
  });
  assert.equal(sell[0]?.kind, "trade");
  if (sell[0]?.kind === "trade") assert.equal(sell[0].txType, "sell");
});
