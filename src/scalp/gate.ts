import type { AppConfig } from "../config.js";
import { readChainFacts } from "../momentum/chain.js";
import { createHoneypotCheck } from "../momentum/honeypot.js";
import type { DexPair, MomentumMarket } from "../momentum/market.js";
import { curveLiquidityUsd } from "../momentum/rules.js";
import type { ScalpGateFacts } from "./rules.js";

export interface ScalpHint {
  ageMs: number | null;
  liquidityUsd: number | null;
  bundlePct: number | null;
  creator: string | null;
}

/**
 * DexScreener plus the rug RPC, raced against the gate budget. A timeout is a
 * skip. Successful pair and holder reads are reused for 15 seconds.
 */
export function createScalpGate(
  config: AppConfig,
  market: MomentumMarket,
  now: () => number = Date.now,
): (mint: string, hint: ScalpHint) => Promise<ScalpGateFacts | "timeout"> {
  const honeypot = createHoneypotCheck(config);
  const cache = new Map<string, { at: number; pair: DexPair | null; chain: Awaited<ReturnType<typeof readChainFacts>> | null }>();
  return async (mint, hint) => {
    const deadline = now() + config.scalpGateMs;
    const remain = () => Math.max(1, deadline - now());
    const cached = cache.get(mint);
    const fresh = cached && now() - cached.at < 15_000 ? cached : null;
    const pairPromise = fresh
      ? Promise.resolve(fresh.pair)
      : withTimeout(market.pair(mint), remain(), null);
    const chainPromise = fresh?.chain
      ? Promise.resolve(fresh.chain)
      : withTimeout(readChainFacts(config.rugCheckRpcUrl, mint, hint.creator), remain(), null);
    const honeyPromise = withTimeout(honeypot(mint), remain(), null);
    const [pair, chain, honey] = await Promise.all([pairPromise, chainPromise, honeyPromise]);
    if (!fresh) cache.set(mint, { at: now(), pair: pair ?? null, chain });
    if (pair === null && chain === null && honey === null && !fresh) return "timeout";
    const ageMs = hint.ageMs ?? (pair?.pairCreatedAtMs != null ? now() - pair.pairCreatedAtMs : null);
    const fromCurve = hint.liquidityUsd;
    const fromDex = pair ? curveLiquidityUsd(pair.quoteAmount, null, pair.liquidityUsd) : 0;
    const liquidityUsd = fromCurve != null && fromCurve > 0 ? fromCurve : fromDex > 0 ? fromDex : null;
    if (!chain || !honey) return "timeout";
    return {
      ageMs,
      liquidityUsd,
      mintOk: chain.mintOk,
      mintReason: chain.mintReason,
      honeypotOk: honey.ok,
      honeypotReason: honey.reason,
      top10Pct: chain.top10Pct,
      devPct: chain.devPct,
      bundlePct: hint.bundlePct,
      socialsOk: pair?.socialsOk === true,
    };
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
