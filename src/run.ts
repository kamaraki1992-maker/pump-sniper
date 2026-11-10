import { existsSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { BoughtMints } from "./bought.js";
import { SniperBot } from "./bot.js";
import { fetchCurveReserves, RpcCurveWatch } from "./curve-watch.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { cuLimitFromConsumed } from "./compute.js";
import { PaperExecutor } from "./executor-paper.js";
import { createLivePorts, LiveExecutor } from "./executor-live.js";
import { PriorityFeeEstimator } from "./priority-fee.js";
import { RpcHolderCheck } from "./holders.js";
import { RpcCreatorHistory } from "./history.js";
import { createRpcFetch, createRpcStats, startRpcPressureLog } from "./rpc-limit.js";
import { Logger } from "./logger.js";
import { PositionBook } from "./positions.js";
import { installProcessRedaction, rpcApiKey } from "./redact.js";
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
  unsubscribeTrades(mints: string[]): void;
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
  stopRpcPressure: () => void;
}

export function readSecrets(): string[] {
  const secrets: string[] = [];
  const key = process.env.PRIVATE_KEY?.trim();
  const grpcToken = process.env.GRPC_TOKEN?.trim();
  if (key) secrets.push(key);
  if (grpcToken && grpcToken.length >= 8) secrets.push(grpcToken);
  const rpcKey = rpcApiKey(process.env.RPC_WS_URL?.trim() ?? "");
  if (rpcKey && rpcKey.length >= 8) secrets.push(rpcKey);
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
  const rpcStats = createRpcStats();
  const rpcFetch = createRpcFetch({
    rps: config.heliusRps,
    cacheTtlMs: config.rpcCacheTtlMs,
    stats: rpcStats,
  });
  const stopPressureLog = startRpcPressureLog(log, rpcStats);
  const history = new RpcCreatorHistory(config, log, Date.now, rpcFetch);
  const holders = new RpcHolderCheck(config.rpcUrl, config.maxTop10Pct, rpcFetch, log, {
    timeoutMs: config.rugCheckTimeoutMs,
  });
  const botRef: {
    onCurveReserves: (
      mint: string,
      realSol: number,
      reserves?: { vSol: number; vTokens: number } | null,
      complete?: boolean,
    ) => void;
  } = {
    onCurveReserves: () => {},
  };
  const curveWatch = config.rpcWsUrl
    ? new RpcCurveWatch(config.rpcWsUrl, log, (mint, realSol, reserves, complete) =>
        botRef.onCurveReserves(mint, realSol, reserves, complete),
      )
    : undefined;
  const priorityFees = new PriorityFeeEstimator(
    config.rpcUrl,
    config.priorityFeeSol,
    config.priorityFeeMaxLamports,
    config.priorityFeeCacheMs,
    rpcFetch,
  );
  const quotePriorityFee = (accountKeys: string[], cuLimit: number) =>
    priorityFees.quote(accountKeys, cuLimit).then((quote) => quote.sol);
  let executor: Executor;
  let walletBalanceSol: (() => Promise<number>) | undefined;
  if (config.mode === "live") {
    const keypair = loadLiveKeypair();
    log.info("live mode", { pubkey: keypair.publicKey.toBase58() });
    const connection = new Connection(config.rpcUrl, {
      commitment: "confirmed",
      fetch: rpcFetch,
      disableRetryOnRateLimit: true,
    });
    const ports = createLivePorts(config, keypair, connection);
    ports.priorityFee = quotePriorityFee;
    executor = new LiveExecutor(ports);
    walletBalanceSol = async () => {
      const lamports = await connection.getBalance(keypair.publicKey, "processed");
      return lamports / 1e9;
    };
  } else {
    log.info("paper mode");
    executor = new PaperExecutor(config.paper, (order) =>
      quotePriorityFee(order.mint ? [order.mint] : [], cuLimitFromConsumed(null)),
    );
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
    unsubscribeMint: (mint) => subscription.stream?.unsubscribeTrades([mint]),
    bought: new BoughtMints(`${config.dataDir}/bought-mints.json`),
    ...(walletBalanceSol ? { walletBalanceSol } : {}),
    holders,
    safetyCheck: createRpcSafetyCheck(config, rpcFetch),
    ...(curveWatch ? { curveWatch } : {}),
    readCurveReserves: (mint) => fetchCurveReserves(config.rpcUrl, mint, rpcFetch),
  });
  if (curveWatch) {
    botRef.onCurveReserves = (mint, realSol, reserves, complete) =>
      bot.onCurveReserves(mint, realSol, reserves, complete);
    curveWatch.start();
  }
  return { config, log, bot, positions, sol, executor, subscription, stopRpcPressure: stopPressureLog };
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
    if (event.kind === "graduation") {
      void runtime.bot.onGraduation(event);
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
    buySlippagePct: config.buySlippagePct,
    sellSlippagePct: config.sellSlippagePct,
    jitoTipSol: config.jitoTipSol,
    stopLossPct: config.stopLossPct,
    trailActivatePct: config.trailActivatePct,
    trailDistancePct: config.trailDistancePct,
    tp1Pct: config.tp1Pct,
    tp1SellFraction: config.tp1SellFraction,
    maxOpenPositions: config.maxOpenPositions,
    maxHoldMinutes: config.maxHoldMinutes,
    volumeStallSec: config.volumeStallSec,
    volumeStallGraceSec: config.volumeStallGraceSec,
  });
  if (config.ignoredTrailTiers) {
    log.info("TRAIL_TIERS is ignored; the trail uses TRAIL_ACTIVATE_PCT and TRAIL_DISTANCE_PCT");
  }
  if (config.ignoredTakeProfit) {
    log.info("TAKE_PROFIT_PCT is ignored; the partial take profit uses TP1_PCT");
  }
  const stream = attachStream(runtime);
  let stopped = false;
  const shutdown = (why: string) => {
    if (stopped) return;
    stopped = true;
    bot.stop();
    log.info("shutdown", { why });
    stream.stop();
    runtime.stopRpcPressure();
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
