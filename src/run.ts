import { existsSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { SniperBot } from "./bot.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { PaperExecutor } from "./executor-paper.js";
import { createLivePorts, LiveExecutor } from "./executor-live.js";
import { RpcCreatorHistory } from "./history.js";
import { Logger } from "./logger.js";
import { PositionBook } from "./positions.js";
import { installProcessRedaction } from "./redact.js";
import { TradeLog } from "./report.js";
import { SolPriceFeed } from "./sol-price.js";
import { PumpDevStream } from "./stream.js";
import type { Executor } from "./types.js";

export interface Runtime {
  config: AppConfig;
  log: Logger;
  bot: SniperBot;
  positions: PositionBook;
  sol: SolPriceFeed;
  executor: Executor;
  subscription: { stream: PumpDevStream | null };
}

export function readSecrets(): string[] {
  const key = process.env.PRIVATE_KEY?.trim();
  return key ? [key] : [];
}

export function loadLiveKeypair(): Keypair {
  const raw = process.env.PRIVATE_KEY?.trim() ?? "";
  try {
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    throw new ConfigError("PRIVATE_KEY is not a valid base58 secret key");
  }
}

export async function buildRuntime(config: AppConfig = loadConfig()): Promise<Runtime> {
  const secrets = readSecrets();
  installProcessRedaction(secrets);
  const log = new Logger(secrets);
  const positions = new PositionBook(config.positionsPath);
  const trades = new TradeLog(config.tradesPath, secrets);
  const sol = new SolPriceFeed(config.solPriceUrl);
  await sol.refresh();
  const history = new RpcCreatorHistory(config, log);
  let executor: Executor;
  if (config.mode === "live") {
    const keypair = loadLiveKeypair();
    log.info("live mode", { pubkey: keypair.publicKey.toBase58() });
    const connection = new Connection(config.rpcUrl, "confirmed");
    executor = new LiveExecutor(createLivePorts(config, keypair, connection));
  } else {
    log.info("paper mode");
    executor = new PaperExecutor(config.paper);
  }
  const subscription: { stream: PumpDevStream | null } = { stream: null };
  const bot = new SniperBot({
    config,
    executor,
    history,
    positions,
    trades,
    log,
    solUsd: () => sol.price(),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    subscribeMint: (mint) => subscription.stream?.subscribeTrades([mint]),
  });
  return { config, log, bot, positions, sol, executor, subscription };
}

export function attachStream(runtime: Runtime): PumpDevStream {
  const stream = new PumpDevStream(runtime.config.wsUrl, runtime.log);
  runtime.subscription.stream = stream;
  stream.start((event) => {
    if (event.kind === "launch") {
      void runtime.bot.onLaunch(event);
      return;
    }
    void runtime.bot.onTrade(event);
  });
  for (const position of runtime.positions.list()) stream.subscribeTrades([position.mint]);
  return stream;
}

export async function runSniper(options: { maxRuntimeMs?: number } = {}): Promise<void> {
  const runtime = await buildRuntime();
  const { config, log, bot, positions, sol } = runtime;
  log.info("sniper start", {
    mode: config.mode,
    buySizeSol: config.buySizeSol,
    maxSlippagePct: config.maxSlippagePct,
    jitoTipSol: config.jitoTipSol,
    takeProfitPct: config.takeProfitPct,
    stopLossPct: config.stopLossPct,
  });
  const stream = attachStream(runtime);
  let stopped = false;
  const shutdown = (why: string) => {
    if (stopped) return;
    stopped = true;
    bot.stop();
    log.info("shutdown", { why });
    stream.stop();
    positions.save(sol.price(), config.paper, new Date().toISOString());
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("sigterm"));
  process.on("SIGINT", () => shutdown("sigint"));
  const stopWatch = setInterval(() => {
    if (existsSync(config.stopFile)) shutdown("stop-file");
  }, 500);
  const priceWatch = setInterval(() => {
    void sol.refresh();
    positions.save(sol.price(), config.paper, new Date().toISOString());
  }, 5_000);
  stopWatch.unref();
  priceWatch.unref();
  if (options.maxRuntimeMs && options.maxRuntimeMs > 0) {
    const timer = setTimeout(() => shutdown("max-runtime"), options.maxRuntimeMs);
    timer.unref();
  }
  await new Promise(() => {});
}
