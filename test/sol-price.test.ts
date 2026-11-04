import assert from "node:assert/strict";
import { test } from "node:test";
import { SOL_PRICE_MAX_AGE_MS, SolPriceFeed } from "../src/sol-price.js";

test("a SOL/USD quote older than 60s is not fresh", async () => {
  let now = 1_000_000;
  const feed = new SolPriceFeed(
    "https://example.test/sol",
    (async () =>
      new Response(JSON.stringify({ solana: { usd: 100 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    () => now,
  );
  assert.equal(await feed.refresh(), 100);
  assert.equal(feed.fresh(SOL_PRICE_MAX_AGE_MS), 100);
  now += SOL_PRICE_MAX_AGE_MS;
  assert.equal(feed.fresh(SOL_PRICE_MAX_AGE_MS), 100);
  now += 1;
  assert.equal(feed.fresh(SOL_PRICE_MAX_AGE_MS), null);
  assert.equal(feed.price(), 100);
});
