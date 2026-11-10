import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateEntry, type EntryPrint } from "../src/entry.js";
import { tipForTrade } from "../src/tip.js";
import { loadConfig } from "../src/config.js";

const base = {
  startedAtMs: 0,
  nowMs: 15_000,
  startPrice: 1,
  price: 1.2,
  creator: "Creator",
  bundled: new Set<string>(),
  minBuys: 8,
  minUniqueBuyers: 5,
  minNetBuySol: 1,
  minBuyRatio: 0.6,
  maxRunupPct: 60,
};

function organicBuys(): EntryPrint[] {
  const wallets = ["a", "b", "c", "d", "e"];
  const times = [1_000, 2_000, 3_000, 6_000, 7_000, 8_000, 12_000, 13_000];
  return times.map((atMs, index) => ({
    atMs,
    side: "buy" as const,
    trader: wallets[index % wallets.length] ?? "a",
    sol: 0.2,
  }));
}

test("eight buys from five wallets across two buckets pass", () => {
  const verdict = evaluateEntry({ ...base, prints: organicBuys() });
  assert.equal(verdict.ok, true);
});

test("bundled snipers and the creator do not count, and a creator sell drops the watch", () => {
  const prints = organicBuys();
  const first = prints[0];
  if (!first) return;
  prints[0] = { atMs: first.atMs, side: first.side, trader: "Creator", sol: first.sol };
  const short = evaluateEntry({ ...base, prints });
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.reason, "entry_low_buyers");

  const bundled = new Set(["a"]);
  const excluded = evaluateEntry({ ...base, bundled, prints: organicBuys() });
  assert.equal(excluded.ok, false);
  if (!excluded.ok) assert.equal(excluded.reason, "entry_low_buyers");

  const dumped = evaluateEntry({
    ...base,
    prints: [...organicBuys(), { atMs: 14_000, side: "sell", trader: "Creator", sol: 0.1 }],
  });
  assert.equal(dumped.ok, false);
  if (!dumped.ok) assert.equal(dumped.reason, "entry_creator_sold");
});

test("low net volume, a single burst, and a chase each have their own reason", () => {
  const thin = organicBuys().map((print) => ({ ...print, sol: 0.01 }));
  const volume = evaluateEntry({ ...base, prints: thin });
  assert.equal(volume.ok, false);
  if (!volume.ok) assert.equal(volume.reason, "entry_low_volume");

  const burst = organicBuys().map((print) => ({ ...print, atMs: 12_000 }));
  const oneBucket = evaluateEntry({ ...base, prints: burst });
  assert.equal(oneBucket.ok, false);
  if (!oneBucket.ok) assert.equal(oneBucket.reason, "entry_burst");

  const chase = evaluateEntry({ ...base, prints: organicBuys(), price: 1.7 });
  assert.equal(chase.ok, false);
  if (!chase.ok) assert.equal(chase.reason, "entry_runup");

  const flat = evaluateEntry({ ...base, prints: organicBuys(), price: 1 });
  assert.equal(flat.ok, false);
  if (!flat.ok) assert.equal(flat.reason, "entry_runup");
});

test("the tip is 1% of size, clamped, and emergency exits pay the max", () => {
  const config = loadConfig({});
  assert.equal(tipForTrade(config, 0.15), 0.0015);
  assert.equal(tipForTrade(config, 0.02), 0.0005);
  assert.equal(tipForTrade(config, 0.29), 0.0015);
  assert.equal(tipForTrade(config, 0.02, true), 0.0015);
  const fixed = loadConfig({ JITO_TIP_SOL: "0.002" });
  assert.equal(tipForTrade(fixed, 0.29), 0.002);
  assert.equal(tipForTrade(fixed, 0.29, true), 0.002);
});
