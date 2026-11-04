import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { clampBuyUsd, ConfigError, loadConfig, requiredBuyBalanceSol } from "../src/config.js";

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
  assert.equal(cfg.buySizeMinUsd, 5);
  assert.equal(cfg.buySizeMaxUsd, 30);
  assert.equal(cfg.maxSlippagePct, 3);
  assert.equal(cfg.jitoTipSol, 0.002);
  assert.equal(cfg.takeProfitPct, 50);
  assert.equal(cfg.stopLossPct, 15);
  assert.equal(cfg.maxOpenPositions, 5);
  assert.equal(cfg.maxHoldMinutes, 10);
  assert.equal(cfg.liqDropPct, 20);
  assert.equal(cfg.volumeStallSec, 45);
  assert.equal(cfg.sellPressureRatio, 3);
  assert.equal(cfg.safetyCheckTimeoutMs, 250);
  assert.equal(cfg.grpcUrl, null);
});

test("buy size, slippage, and tip hard caps refuse startup", () => {
  assert.throws(() => loadConfig({ BUY_SIZE_MAX_USD: "31" }), ConfigError);
  assert.throws(() => loadConfig({ BUY_SIZE_MAX_USD: "30.01" }), ConfigError);
  assert.throws(() => loadConfig({ BUY_SIZE_MIN_USD: "0" }), ConfigError);
  assert.equal(loadConfig({ BUY_SIZE_MAX_USD: "30" }).buySizeMaxUsd, 30);
  assert.equal(loadConfig({ BUY_SIZE_MIN_USD: "5", BUY_SIZE_MAX_USD: "20" }).buySizeMaxUsd, 20);
  assert.throws(() => loadConfig({ MAX_SLIPPAGE_PCT: "21" }), ConfigError);
  assert.equal(loadConfig({ MAX_SLIPPAGE_PCT: "20" }).maxSlippagePct, 20);
  assert.equal(loadConfig({}).maxSlippagePct, 3);
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

test("open positions cannot be loosened past 5", () => {
  assert.throws(() => loadConfig({ MAX_OPEN_POSITIONS: "6" }), ConfigError);
  assert.throws(() => loadConfig({ MAX_OPEN_POSITIONS: "0" }), ConfigError);
  assert.equal(loadConfig({ MAX_OPEN_POSITIONS: "5" }).maxOpenPositions, 5);
  assert.equal(loadConfig({ MAX_OPEN_POSITIONS: "1" }).maxOpenPositions, 1);
});

test("live buy reserves exit SOL for the USD notional and for positions already open", () => {
  const cfg = loadConfig({});
  const fee = 0.00005 + 0.000005;
  const tip = 0.002;
  const sizeSol = clampBuyUsd(30) / 100;
  const one = requiredBuyBalanceSol(cfg, sizeSol, 0);
  assert.equal(clampBuyUsd(40), 30);
  assert.ok(Math.abs(one - (sizeSol + fee + tip + fee + tip)) < 1e-12);
  const withOpen = requiredBuyBalanceSol(cfg, sizeSol, 2);
  assert.ok(Math.abs(withOpen - (one + 2 * (fee + tip))) < 1e-12);
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
