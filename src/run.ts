import { existsSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { BoughtMints } from "./bought.js";
import { SniperBot } from "./bot.js";
import { fetchCurveReserves, RpcCurveWatch } from "./curve-watch.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { cuLimitFromConsumed } from "./compute.js";
import { PaperExecutor } from "./executor-paper.js";
import { PaperBalance } from "./paper-balance.js";
import { confirmSignature, createLivePorts, LiveExecutor } from "./executor-live.js";
import { PriorityFeeEstimator } from "./priority-fee.js";
import { RpcHolderCheck } from "./holders.js";
import { installProcessGuards } from "./guards.js";
import { RpcCreatorHistory } from "./history.js";
import { createRpcFetch, createRpcStats, startRpcPressureLog } from "./rpc-limit.js";
import { Logger } from "./logger.js";
import { MetadataSocials } from "./socials.js";
import { PositionBook } from "./positions.js";
import { installProcessRedaction, rpcApiKey, rpcHost } from "./redact.js";
import { TradeLog } from "./report.js";
import { SolPriceFeed } from "./sol-price.js";
import { createRpcSafetyCheck } from "./safety.js";
import { createHoneypotCheck } from "./momentum/honeypot.js";
import { readChainFacts } from "./momentum/chain.js";
import { HttpMomentumMarket } from "./momentum/market.js";
import { solFromUsdBalance } from "./momentum/paper.js";
import { reclaimEmptyAta } from "./momentum/rent.js";
import { MomentumRunner } from "./momentum/runner.js";
import { HeliusFeed } from "./helius-feed.js";
import { ScalpRunner } from "./scalp/runner.js";
import { createScalpGate } from "./scalp/gate.js";
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
  trades: TradeLog;
  sol: SolPriceFeed;
  executor: Executor;
  subscription: { stream: LiveStream | null };
  stopRpcPressure: () => void;
  paperBalance?: PaperBalance;
  walletBalanceSol?: () => Promise<number>;
  quoteFee?: (level: "medium" | "high", mint: string) => Promise<number>;
  reclaimRent?: (mint: string) => Promise<{ closed: boolean; rentSol: number; reason: string }>;
}

/** Optional ceiling. Absent or invalid keeps the tier's own subscription limit. */
export function pumpDevMaxSubscriptions(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

export function readSecrets(): string[] {
  const secrets: string[] = [];
  const key = process.env.PRIVATE_KEY?.trim();
  const grpcToken = process.env.GRPC_TOKEN?.trim();
  if (key) secrets.push(key);
  if (grpcToken && grpcToken.length >= 8) secrets.push(grpcToken);
  const rpcKey = rpcApiKey(process.env.RPC_WS_URL?.trim() ?? "");
  if (rpcKey && rpcKey.length >= 8) secrets.push(rpcKey);
  const rugKey = rpcApiKey(process.env.RUG_CHECK_RPC_URL?.trim() ?? "");
  if (rugKey && rugKey.length >= 8) secrets.push(rugKey);
  const pumpDevKey = process.env.PUMPDEV_API_KEY?.trim();
  if (pumpDevKey && pumpDevKey.length >= 8) secrets.push(pumpDevKey);
  const portalKey = process.env.PUMPPORTAL_API_KEY?.trim();
  if (portalKey && portalKey.length >= 8) secrets.push(portalKey);
  const wsKey = rpcApiKey(process.env.WS_URL?.trim() ?? "");
  if (wsKey && wsKey.length >= 8) secrets.push(wsKey);
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
  const startedSolUsd = sol.fresh() ?? sol.price();
  const paperStartSol =
    config.paperStartBalanceSol ??
    (config.paperStartBalanceUsd != null ? solFromUsdBalance(config.paperStartBalanceUsd, startedSolUsd ?? 0) : null);
  if (
    config.strategy === "momentum" &&
    config.mode === "paper" &&
    config.paperStartBalanceSol == null &&
    config.paperStartBalanceUsd != null &&
    paperStartSol == null
  ) {
    throw new ConfigError("PAPER_START_BALANCE_USD needs a live SOL/USD price");
  }
  if (config.paperStartBalanceSol == null && paperStartSol != null && config.paperStartBalanceUsd != null) {
    log.info("paper start balance", {
      usd: config.paperStartBalanceUsd,
      solUsd: startedSolUsd,
      sol: paperStartSol,
    });
  }
  const paperBalance =
    config.mode === "paper" &&
    paperStartSol != null &&
    (config.buySizePctOfBalance != null || config.strategy === "momentum" || config.strategy === "scalp")
      ? new PaperBalance(`${config.dataDir}/paper-balance.json`, paperStartSol)
      : undefined;
  const rpcStats = createRpcStats();
  const rpcFetch = createRpcFetch({
    rps: config.heliusRps,
    cacheTtlMs: config.rpcCacheTtlMs,
    stats: rpcStats,
  });
  const stopPressureLog = startRpcPressureLog(log, rpcStats);
  const history = new RpcCreatorHistory(config, log, Date.now, rpcFetch);
  const holders = new RpcHolderCheck(config.rugCheckRpcUrl, config.maxTop10Pct, rpcFetch, log, {
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
  const quotePriorityFee = (accountKeys: string[], cuLimit: number, level?: "medium" | "high") => {
    if (level === "medium" || level === "high") {
      const capSol = level === "high" ? config.momentumTurboFeeSol : config.momentumPriorityFeeSol;
      return priorityFees
        .quote(accountKeys, cuLimit, {
          level: level === "high" ? "High" : "Medium",
          maxLamports: Math.round(capSol * 1e9),
        })
        .then((quote) => quote.sol);
    }
    return priorityFees.quote(accountKeys, cuLimit).then((quote) => quote.sol);
  };
  let executor: Executor;
  let walletBalanceSol: (() => Promise<number>) | undefined;
  let reclaimRent: Runtime["reclaimRent"] = undefined;
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
    reclaimRent = async (mint: string) => {
      const result = await reclaimEmptyAta({
        connection,
        owner: keypair,
        mint: new PublicKey(mint),
        blockhash: async () => (await connection.getLatestBlockhash("processed")).blockhash,
        send: (tx) => connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 }),
        confirm: async (signature) =>
          (await confirmSignature(connection, signature, config.confirmTimeoutMs)).state === "landed",
      });
      return { closed: result.closed, rentSol: result.rentSol, reason: result.reason };
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
    ...(paperBalance && config.buySizePctOfBalance != null ? { paperBalance } : {}),
    holders,
    metadataSocials: new MetadataSocials({
      attemptTimeoutMs: config.metadataAttemptTimeoutMs,
      retry: config.metadataRetry,
      mode: config.requireSocialsMode,
    }),
    safetyCheck: createRpcSafetyCheck(config, rpcFetch),
    ...(curveWatch ? { curveWatch } : {}),
    readCurveReserves: (mint) => fetchCurveReserves(config.rpcUrl, mint, rpcFetch),
  });
  if (curveWatch) {
    botRef.onCurveReserves = (mint, realSol, reserves, complete) =>
      bot.onCurveReserves(mint, realSol, reserves, complete);
    curveWatch.start();
  }
  return {
    config,
    log,
    bot,
    positions,
    trades,
    sol,
    executor,
    subscription,
    stopRpcPressure: stopPressureLog,
    ...(paperBalance ? { paperBalance } : {}),
    ...(walletBalanceSol ? { walletBalanceSol } : {}),
    quoteFee: (level, mint) => quotePriorityFee([mint], 200_000, level),
    ...(reclaimRent ? { reclaimRent } : {}),
  };
}

function openDataFeed(runtime: Runtime): LiveStream {
  if (runtime.config.feed === "pumpdev") {
    return new PumpDevStream(runtime.config.wsUrl, runtime.log, undefined, undefined, {
      feed: "pumpdev",
      apiKey: process.env.PUMPDEV_API_KEY?.trim() || null,
      maxSubscriptions: pumpDevMaxSubscriptions(process.env.PUMPDEV_MAX_SUBSCRIPTIONS),
    });
  }
  if (runtime.config.feed === "pumpportal") {
    return new PumpDevStream(runtime.config.dataWsUrl, runtime.log, undefined, undefined, {
      feed: "pumpportal",
      apiKey: process.env.PUMPPORTAL_API_KEY?.trim() || null,
    });
  }
  return new HeliusFeed(runtime.config.rpcWsUrl ?? "", runtime.log, {
    stallMs: runtime.config.feedStallSec * 1000,
  });
}

export function attachStream(runtime: Runtime): LiveStream {
  const grpcToken = process.env.GRPC_TOKEN?.trim() ?? "";
  const stream: LiveStream =
    runtime.config.grpcUrl && grpcToken
      ? new YellowstoneStream(runtime.config.grpcUrl, grpcToken, runtime.log)
      : openDataFeed(runtime);
  if (!(stream instanceof YellowstoneStream)) {
    runtime.log.info("stream", { source: runtime.config.feed, feed: runtime.config.feed });
  }
  runtime.subscription.stream = stream;
  const fail = (error: unknown) => {
    runtime.log.error("event failed", { error: error instanceof Error ? error.message : "event-error" });
  };
  stream.start((event) => {
    if (event.kind === "launch") {
      void runtime.bot.onLaunch(event).catch(fail);
      return;
    }
    if (event.kind === "graduation") {
      void runtime.bot.onGraduation(event).catch(fail);
      return;
    }
    void runtime.bot.onTrade(event).catch(fail);
  });
  for (const position of runtime.positions.list()) stream.subscribeTrades([position.mint]);
  return stream;
}

function attachMomentum(runtime: Runtime, runner: MomentumRunner): LiveStream | null {
  if (runtime.config.feed === "helius" && !runtime.config.rpcWsUrl) {
    runtime.log.info("momentum feed", { source: "dexscreener" });
    return null;
  }
  const stream = openDataFeed(runtime);
  runtime.subscription.stream = stream;
  runtime.log.info("stream", { source: runtime.config.feed, feed: runtime.config.feed });
  stream.start((event) => {
    if (event.kind === "launch") runner.noteLaunch(event);
    else if (event.kind === "graduation") runner.noteGraduation(event);
    else runner.noteTrade(event);
  });
  return stream;
}

export async function runMomentum(runtime: Runtime, options: { maxRuntimeMs?: number } = {}): Promise<void> {
  const { config, log, positions, sol, executor, trades } = runtime;
  const removeGuards = installProcessGuards(log);
  const runner = new MomentumRunner({
    config,
    executor,
    positions,
    trades,
    log,
    solUsd: () => sol.fresh(),
    solLast: () => ({ price: sol.price(), atMs: sol.updatedAt() }),
    now: () => new Date(),
    market: new HttpMomentumMarket(config.momentumPollSec * 1000),
    chain: (mint, creator) => readChainFacts(config.rugCheckRpcUrl, mint, creator),
    ...(runtime.paperBalance ? { paperBalance: runtime.paperBalance } : {}),
    ...(runtime.walletBalanceSol ? { walletBalanceSol: runtime.walletBalanceSol } : {}),
    ...(runtime.quoteFee ? { quoteFee: runtime.quoteFee } : {}),
    ...(runtime.reclaimRent ? { reclaimRent: runtime.reclaimRent } : {}),
    honeypot: createHoneypotCheck(config),
  });
  log.info("momentum start", {
    mode: config.mode,
    pollSec: config.momentumPollSec,
    resistanceCandles: config.momentumResistanceCandles,
    maxOpenPositions: config.maxOpenPositions,
  });
  const stream = attachMomentum(runtime, runner);
  let stopped = false;
  const shutdown = (why: string) => {
    if (stopped) return;
    stopped = true;
    log.info("shutdown", { why });
    stream?.stop();
    runtime.stopRpcPressure();
    removeGuards();
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
  const pollWatch = setInterval(() => {
    void runner.tick().catch((error: unknown) => {
      log.error("momentum tick failed", { error: error instanceof Error ? error.message : "tick" });
    });
  }, config.momentumPollSec * 1000);
  stopWatch.unref();
  priceWatch.unref();
  pollWatch.unref();
  void runner.tick().catch((error: unknown) => {
    log.error("momentum tick failed", { error: error instanceof Error ? error.message : "tick" });
  });
  if (options.maxRuntimeMs && options.maxRuntimeMs > 0) {
    const timer = setTimeout(() => shutdown("max-runtime"), options.maxRuntimeMs);
    timer.unref();
  }
  await new Promise(() => {});
}

function attachScalp(runtime: Runtime, runner: ScalpRunner): LiveStream | null {
  if (!runtime.config.rpcWsUrl) {
    runtime.log.info("scalp feed", { source: "missing" });
    return null;
  }
  const stream = new HeliusFeed(runtime.config.rpcWsUrl, runtime.log, {
    stallMs: runtime.config.feedStallSec * 1000,
    pumpSwap: true,
  });
  runtime.subscription.stream = stream;
  runtime.log.info("stream", { source: "helius", feed: "scalp" });
  stream.start((event) => {
    if (event.kind === "launch") runner.noteLaunch(event);
    else if (event.kind === "graduation") runner.watch(event.mint);
    else if (event.kind === "trade") runner.noteTrade(event);
  });
  return stream;
}

export async function runScalp(runtime: Runtime, options: { maxRuntimeMs?: number } = {}): Promise<void> {
  const { config, log, positions, sol, executor, trades } = runtime;
  const removeGuards = installProcessGuards(log);
  const market = new HttpMomentumMarket(config.momentumPollSec * 1000);
  const runner = new ScalpRunner({
    config,
    executor,
    positions,
    trades,
    log,
    solUsd: () => sol.fresh(),
    solLast: () => ({ price: sol.price(), atMs: sol.updatedAt() }),
    now: () => new Date(),
    market,
    gate: createScalpGate(config, market),
    watch: (mint) => runtime.subscription.stream?.subscribeTrades([mint]),
    ...(runtime.paperBalance ? { paperBalance: runtime.paperBalance } : {}),
    ...(runtime.walletBalanceSol ? { walletBalanceSol: runtime.walletBalanceSol } : {}),
    ...(runtime.reclaimRent ? { reclaimRent: runtime.reclaimRent } : {}),
  });
  log.info("scalp start", {
    mode: config.mode,
    priorityFeeSol: config.scalpPriorityFeeSol,
    maxHoldMin: config.scalpMaxHoldMin,
    gateMs: config.scalpGateMs,
    maxOpenPositions: config.maxOpenPositions,
  });
  const stream = attachScalp(runtime, runner);
  void runner.discover();
  let stopped = false;
  const shutdown = (why: string) => {
    if (stopped) return;
    stopped = true;
    log.info("shutdown", { why });
    stream?.stop();
    runtime.stopRpcPressure();
    removeGuards();
    positions.save(sol.price(), config.paper, new Date().toISOString());
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("sigterm"));
  process.on("SIGINT", () => shutdown("sigint"));
  const stopWatch = setInterval(() => {
    if (existsSync(config.stopFile)) shutdown("stop-file");
  }, 500);
  const clock = setInterval(() => runner.checkClocks(), 1_000);
  const priceWatch = setInterval(() => {
    void sol.refresh();
    void runner.tick();
    positions.save(sol.price(), config.paper, new Date().toISOString());
  }, 5_000);
  stopWatch.unref();
  clock.unref();
  priceWatch.unref();
  if (options.maxRuntimeMs && options.maxRuntimeMs > 0) {
    const timer = setTimeout(() => shutdown("max-runtime"), options.maxRuntimeMs);
    timer.unref();
  }
  await new Promise(() => {});
}

export async function runSniper(options: { maxRuntimeMs?: number } = {}): Promise<void> {
  const runtime = await buildRuntime();
  if (runtime.config.strategy === "scalp") {
    await runScalp(runtime, options);
    return;
  }
  if (runtime.config.strategy === "momentum") {
    await runMomentum(runtime, options);
    return;
  }
  const { config, log, bot, positions, sol } = runtime;
  const removeGuards = installProcessGuards(log);
  const balanceSol = await bot.reportedBalanceSol();
  log.info("rug check rpc", { host: rpcHost(config.rugCheckRpcUrl) });
  log.info("sniper start", {
    mode: config.mode,
    ...(balanceSol != null ? { balanceSol } : {}),
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
    removeGuards();
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
