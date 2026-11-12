import type { AppConfig } from "../config.js";
import { readChainFacts, type ChainFacts } from "../momentum/chain.js";
import { createHoneypotCheck } from "../momentum/honeypot.js";
import type { DexPair, MomentumMarket } from "../momentum/market.js";
import { curveLiquidityUsd } from "../momentum/rules.js";
import type { ScalpGateFacts } from "./rules.js";

export interface ScalpHint {
  ageMs: number | null;
  liquidityUsd: number | null;
  bundlePct: number | null;
  creator: string | null;
  /** Bonding curve or graduated PumpSwap. The sell sim follows this. */
  pool?: "pump" | "pump-amm";
}

/** Reuse a warmed safety read for this long. */
export const SCALP_SAFETY_TTL_MS = 60_000;

export interface ScalpSimResult {
  ok: boolean;
  reason: string | null;
  simMs: number;
  simErr: string | null;
  simLog: string | null;
}

interface SafetySlot {
  at: number;
  creator: string | null;
  pool?: "pump" | "pump-amm";
  pair: Promise<DexPair | null>;
  chain: Promise<ChainFacts | null>;
  honey: Promise<ScalpSimResult>;
  honeySettled: boolean;
}

export interface ScalpGateApi {
  check: (mint: string, hint: ScalpHint) => Promise<ScalpGateFacts | "timeout">;
  /** Start the sell sim and the other safety reads before the entry spike. */
  prewarm: (mint: string, hint: ScalpHint) => void;
}

export interface ScalpGateOptions {
  now?: () => number;
  log?: { info(message: string, fields?: Record<string, unknown>): void };
  honeypot?: (
    mint: string,
    pool?: "pump" | "pump-amm",
  ) => Promise<{ ok: boolean; reason: string | null; simErr?: string | null; simLog?: string | null }>;
  chain?: (mint: string, creator: string | null) => Promise<ChainFacts>;
}

/**
 * Safety reads run together. The sell simulation has its own budget and is
 * started early, then reused. A simulation that does not finish, or that
 * shows the mint cannot be sold, stays a skip.
 */
export function createScalpGate(
  config: AppConfig,
  market: MomentumMarket,
  options: ScalpGateOptions = {},
): ScalpGateApi {
  const now = options.now ?? Date.now;
  const honeypot = options.honeypot ?? createHoneypotCheck(config);
  const chain = options.chain ?? ((mint: string, creator: string | null) => readChainFacts(config.rugCheckRpcUrl, mint, creator));
  const cache = new Map<string, SafetySlot>();

  const loadPair = (mint: string) => withTimeout(market.pair(mint).catch(() => null), config.scalpGateMs, null);
  const loadChain = (mint: string, creator: string | null) =>
    withTimeout(chain(mint, creator).catch(() => null), config.scalpGateMs, null);
  const loadHoney = (mint: string, pool: "pump" | "pump-amm" | undefined, slot: SafetySlot): Promise<ScalpSimResult> => {
    const started = now();
    const work = honeypot(mint, pool).catch(() => ({ ok: false, reason: "honeypot_unsimulated" as string | null }));
    return withTimeout(work, config.scalpSimTimeoutMs, { ok: false, reason: "honeypot_unsimulated" }).then((result) => {
      slot.honeySettled = true;
      return {
        ok: result.ok,
        reason: result.reason,
        simMs: Math.max(0, now() - started),
        simErr: "simErr" in result ? result.simErr ?? null : null,
        simLog: "simLog" in result ? result.simLog ?? null : null,
      };
    });
  };

  const ensure = (mint: string, hint: ScalpHint): SafetySlot => {
    const existing = cache.get(mint);
    if (existing && now() - existing.at < SCALP_SAFETY_TTL_MS) {
      if (hint.creator && hint.creator !== existing.creator) {
        existing.creator = hint.creator;
        existing.chain = loadChain(mint, hint.creator);
      }
      if (hint.pool && hint.pool !== existing.pool) {
        existing.pool = hint.pool;
        existing.honeySettled = false;
        existing.honey = loadHoney(mint, hint.pool, existing);
      }
      return existing;
    }
    const slot: SafetySlot = {
      at: now(),
      creator: hint.creator,
      pool: hint.pool,
      pair: Promise.resolve(null),
      chain: Promise.resolve(null),
      honey: Promise.resolve({ ok: false, reason: "honeypot_unsimulated", simMs: 0, simErr: null, simLog: null }),
      honeySettled: false,
    };
    slot.pair = loadPair(mint);
    slot.chain = loadChain(mint, hint.creator);
    slot.honey = loadHoney(mint, hint.pool, slot);
    cache.set(mint, slot);
    return slot;
  };

  return {
    prewarm(mint, hint) {
      ensure(mint, hint);
    },
    async check(mint, hint) {
      const slot = ensure(mint, hint);
      const cacheHit = slot.honeySettled;
      const [pair, chainFacts, honey] = await Promise.all([slot.pair, slot.chain, slot.honey]);
      options.log?.info("scalp", {
        mint,
        decision: "sim",
        simMs: honey.simMs,
        cacheHit,
        reason: honey.reason,
        simErr: honey.simErr,
        simLog: honey.simLog,
      });
      if (!chainFacts) return "timeout";
      const ageMs = hint.ageMs ?? (pair?.pairCreatedAtMs != null ? now() - pair.pairCreatedAtMs : null);
      const fromCurve = hint.liquidityUsd;
      const fromDex = pair ? curveLiquidityUsd(pair.quoteAmount, null, pair.liquidityUsd) : 0;
      const liquidityUsd = fromCurve != null && fromCurve > 0 ? fromCurve : fromDex > 0 ? fromDex : null;
      return {
        ageMs,
        liquidityUsd,
        mintOk: chainFacts.mintOk,
        mintReason: chainFacts.mintReason,
        honeypotOk: honey.ok,
        honeypotReason: honey.reason,
        top10Pct: chainFacts.top10Pct,
        devPct: chainFacts.devPct,
        bundlePct: hint.bundlePct,
        socialsOk: pair?.socialsOk === true,
      };
    },
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
