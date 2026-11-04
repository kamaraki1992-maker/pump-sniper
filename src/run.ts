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
import { createRpcSafetyCheck } from "./safety.js";
import { PumpDevStream } from "./stream.js";
import type { MarketEvent } from "./types.js";
import { YellowstoneStream } from "./yellowstone.js";
import type { Executor } from "./types.js";

type LiveStream = {
  start(onEvent: (event: MarketEvent) => void): void;
  subscribeTrades(mints: string[]): void;
  stop(): void;
};

export interface Runtime {
  config: AppConfig;
  log: Logger;
  bot: SniperBot;
  positions: PositionBook;
  sol: SolPriceFeed;
  executor: Executor;
  subscription: { stream: LiveStream | null };
}

export function readSecrets(): string[] {
  const secrets: string[] = [];
  const key = process.env.PRIVATE_KEY?.trim();
  const grpcToken = process.env.GRPC_TOKEN?.trim();
  if (key) secrets.push(key);
  if (grpcToken && grpcToken.length >= 8) secrets.push(grpcToken);
  return secrets;
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
  let walletBalanceSol: (() => Promise<number>) | undefined;
  if (config.mode === "live") {
    const keypair = loadLiveKeypair();
    log.info("live mode", { pubkey: keypair.publicKey.toBase58() });
    const connection = new Connection(config.rpcUrl, "confirmed");
    executor = new LiveExecutor(createLivePorts(config, keypair, connection));
    walletBalanceSol = async () => {
      const lamports = await connection.getBalance(keypair.publicKey, "processed");
      return lamports / 1e9;
    };
  } else {
    log.info("paper mode");
    executor = new PaperExecutor(config.paper);
  }
  const subscription: { stream: LiveStream | null } = { stream: null };
  const bot = new SniperBot({
    config,
    executor,
    history,
    positions,
    trades,
    log,
    solUsd: () => sol.price(),
    solQuote: () => {
      const usd = sol.fresh();
      const updatedAtMs = sol.updatedAt();
      if (usd === null || updatedAtMs === null) return null;
      return { usd, updatedAtMs };
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    subscribeMint: (mint) => subscription.stream?.subscribeTrades([mint]),
    ...(walletBalanceSol ? { walletBalanceSol } : {}),
    safetyCheck: createRpcSafetyCheck(config),
  });
  return { config, log, bot, positions, sol, executor, subscription };
}

export function attachStream(runtime: Runtime): LiveStream {
  const grpcToken = process.env.GRPC_TOKEN?.trim() ?? "";
  const stream: LiveStream =
    runtime.config.grpcUrl && grpcToken
      ? new YellowstoneStream(runtime.config.grpcUrl, grpcToken, runtime.log)
      : new PumpDevStream(runtime.config.wsUrl, runtime.log);
  if (!(stream instanceof YellowstoneStream)) {
    runtime.log.info("stream", { source: "pumpdev-ws" });
  }
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
    buySizeMinUsd: config.buySizeMinUsd,
    buySizeMaxUsd: config.buySizeMaxUsd,
    maxSlippagePct: config.maxSlippagePct,
    jitoTipSol: config.jitoTipSol,
    takeProfitPct: config.takeProfitPct,
    stopLossPct: config.stopLossPct,
    maxOpenPositions: config.maxOpenPositions,
    maxHoldMinutes: config.maxHoldMinutes,
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
  const holdWatch = setInterval(() => {
    void bot.checkHolds();
  }, 1_000);
  stopWatch.unref();
  priceWatch.unref();
  holdWatch.unref();
  if (options.maxRuntimeMs && options.maxRuntimeMs > 0) {
    const timer = setTimeout(() => shutdown("max-runtime"), options.maxRuntimeMs);
    timer.unref();
  }
  await new Promise(() => {});
}
