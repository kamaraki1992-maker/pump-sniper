import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { ConfigError, loadConfig, requiredBuyBalanceSol } from "../src/config.js";

const secret = bs58.encode(Keypair.generate().secretKey);

test("anything other than MODE=live is paper, including missing and LIVE", () => {
  assert.equal(loadConfig({}).mode, "paper");
  assert.equal(loadConfig({ MODE: "paper" }).mode, "paper");
  assert.equal(loadConfig({ MODE: "LIVE" }).mode, "paper");
  assert.equal(loadConfig({ MODE: "" }).mode, "paper");
  assert.equal(loadConfig({ MODE: "live", PRIVATE_KEY: secret }).mode, "live");
});

test("paper mode does not require a key and does not keep the key on the config", () => {
  const cfg = loadConfig({ PRIVATE_KEY: secret });
  assert.equal(cfg.mode, "paper");
  assert.equal(JSON.stringify(cfg).includes(secret), false);
});

test("defaults match the risk spec", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.buySizeSol, 0.1);
  assert.equal(cfg.maxSlippagePct, 20);
  assert.equal(cfg.jitoTipSol, 0.002);
  assert.equal(cfg.takeProfitPct, 50);
  assert.equal(cfg.stopLossPct, 15);
  assert.equal(cfg.maxOpenPositions, 1);
});

test("buy size, slippage, and tip hard caps refuse startup", () => {
  assert.throws(() => loadConfig({ BUY_SIZE_SOL: "0.11" }), ConfigError);
  assert.throws(() => loadConfig({ BUY_SIZE_SOL: "0" }), ConfigError);
  assert.equal(loadConfig({ BUY_SIZE_SOL: "0.1" }).buySizeSol, 0.1);
  assert.throws(() => loadConfig({ MAX_SLIPPAGE_PCT: "21" }), ConfigError);
  assert.equal(loadConfig({ MAX_SLIPPAGE_PCT: "20" }).maxSlippagePct, 20);
  assert.throws(() => loadConfig({ JITO_TIP_SOL: "0.001" }), ConfigError);
  assert.throws(() => loadConfig({ JITO_TIP_SOL: "0.006" }), ConfigError);
  assert.equal(loadConfig({ JITO_TIP_SOL: "0.002" }).jitoTipSol, 0.002);
  assert.equal(loadConfig({ JITO_TIP_SOL: "0.005" }).jitoTipSol, 0.005);
});

test("take profit and stop loss cannot be loosened past 50% and 15%", () => {
  assert.throws(() => loadConfig({ TAKE_PROFIT_PCT: "51" }), ConfigError);
  assert.throws(() => loadConfig({ TAKE_PROFIT_PCT: "100" }), ConfigError);
  assert.equal(loadConfig({ TAKE_PROFIT_PCT: "50" }).takeProfitPct, 50);
  assert.equal(loadConfig({ TAKE_PROFIT_PCT: "40" }).takeProfitPct, 40);
  assert.throws(() => loadConfig({ STOP_LOSS_PCT: "16" }), ConfigError);
  assert.throws(() => loadConfig({ STOP_LOSS_PCT: "20" }), ConfigError);
  assert.equal(loadConfig({ STOP_LOSS_PCT: "15" }).stopLossPct, 15);
  assert.equal(loadConfig({ STOP_LOSS_PCT: "10" }).stopLossPct, 10);
});

test("open positions cannot be loosened past 1", () => {
  assert.throws(() => loadConfig({ MAX_OPEN_POSITIONS: "2" }), ConfigError);
  assert.throws(() => loadConfig({ MAX_OPEN_POSITIONS: "0" }), ConfigError);
  assert.equal(loadConfig({ MAX_OPEN_POSITIONS: "1" }).maxOpenPositions, 1);
});

test("live buy requires size, fees, tip, and a sell-fee reserve", () => {
  const cfg = loadConfig({});
  const need = requiredBuyBalanceSol(cfg);
  assert.ok(Math.abs(need - (0.1 + 0.00005 + 0.000005 + 0.002 + 0.00005 + 0.000005)) < 1e-12);
});

test("creator hold cannot be loosened past 10%", () => {
  assert.throws(() => loadConfig({ CREATOR_MAX_HOLD_PCT: "11" }), ConfigError);
  assert.equal(loadConfig({ CREATOR_MAX_HOLD_PCT: "10" }).creatorMaxHoldPct, 10);
});

test("live mode requires a usable key and errors do not echo it", () => {
  assert.throws(() => loadConfig({ MODE: "live" }), /PRIVATE_KEY is required/);
  assert.throws(() => loadConfig({ MODE: "live", PRIVATE_KEY: `${secret}nope` }), (error: unknown) => {
    const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    assert.equal(message.includes(secret), false);
    assert.match(message, /not a valid base58 secret key/);
    return true;
  });
  const cfg = loadConfig({ MODE: "live", PRIVATE_KEY: secret });
  assert.equal(JSON.stringify(cfg).includes(secret), false);
});
