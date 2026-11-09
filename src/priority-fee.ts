import { microLamportsForFee } from "./compute.js";

/** Helius `priorityLevel: High`, then this percentile of recent fees when that call is missing. */
export const PRIORITY_FEE_PERCENTILE = 90;
/** Used only to turn a SOL fallback into a compute-unit price. The total stays the SOL amount. */
export const FALLBACK_CU_LIMIT = 200_000;

export interface PriorityFeeQuote {
  /** Microlamports per compute unit after the total-lamport clamp. */
  microLamports: number;
  totalLamports: number;
  sol: number;
  source: "helius" | "recent" | "fallback";
}

/** Cap the per-CU price so `micro * cu / 1e6` cannot exceed `maxLamports`. */
export function clampMicroLamports(microLamports: number, cuLimit: number, maxLamports: number): number {
  if (!(microLamports > 0) || !(cuLimit > 0) || !(maxLamports >= 0)) return 0;
  const maxMicro = Math.floor((maxLamports * 1_000_000) / cuLimit);
  return Math.max(0, Math.min(Math.floor(microLamports), maxMicro));
}

/** High percentile. Index is `ceil(pct/100 * n) - 1` on the sorted positive samples. */
export function highPercentile(values: readonly number[], pct = PRIORITY_FEE_PERCENTILE): number {
  const clean = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (clean.length === 0) return 0;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil((pct / 100) * clean.length) - 1));
  return clean[index] ?? 0;
}

interface RpcEnvelope {
  result?: unknown;
  error?: { message?: string };
}

/**
 * Dynamic compute-unit price. Helius `getPriorityFeeEstimate` at High, then
 * `getRecentPrioritizationFees` at the 90th percentile, then `PRIORITY_FEE_SOL`.
 * The total is clamped to `maxLamports`. A successful read is reused for `cacheMs`.
 */
export class PriorityFeeEstimator {
  private cached: { at: number; key: string; microLamports: number; source: "helius" | "recent" } | null = null;

  constructor(
    private readonly rpcUrl: string,
    private readonly fallbackSol: number,
    private readonly maxLamports: number,
    private readonly cacheMs: number,
    private readonly rpcFetch: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async quote(accountKeys: readonly string[], cuLimit: number): Promise<PriorityFeeQuote> {
    const limit = cuLimit > 0 ? Math.floor(cuLimit) : FALLBACK_CU_LIMIT;
    const sampled = await this.sample(accountKeys);
    if (sampled.source === "fallback") {
      const lamports = Math.max(0, Math.min(Math.round(this.fallbackSol * 1e9), Math.floor(this.maxLamports)));
      return {
        microLamports: microLamportsForFee(lamports / 1e9, limit),
        totalLamports: lamports,
        sol: lamports / 1e9,
        source: "fallback",
      };
    }
    const microLamports = clampMicroLamports(sampled.microLamports, limit, this.maxLamports);
    const totalLamports = Math.floor((microLamports * limit) / 1_000_000);
    return {
      microLamports,
      totalLamports,
      sol: totalLamports / 1e9,
      source: sampled.source,
    };
  }

  private async sample(
    accountKeys: readonly string[],
  ): Promise<{ microLamports: number; source: "helius" | "recent" | "fallback" }> {
    const key = [...accountKeys].sort().join(",");
    const hit = this.cached;
    if (hit && hit.key === key && this.cacheMs > 0 && this.now() - hit.at < this.cacheMs) {
      return { microLamports: hit.microLamports, source: hit.source };
    }
    const helius = await this.helius(accountKeys);
    if (helius > 0) {
      this.cached = { at: this.now(), key, microLamports: helius, source: "helius" };
      return { microLamports: helius, source: "helius" };
    }
    const recent = await this.recent(accountKeys);
    if (recent > 0) {
      this.cached = { at: this.now(), key, microLamports: recent, source: "recent" };
      return { microLamports: recent, source: "recent" };
    }
    return { microLamports: 0, source: "fallback" };
  }

  private async helius(accountKeys: readonly string[]): Promise<number> {
    try {
      const options = { priorityLevel: "High" };
      const params =
        accountKeys.length > 0 ? [{ accountKeys: [...accountKeys], options }] : [{ options }];
      const result = await this.rpc("getPriorityFeeEstimate", params);
      if (typeof result === "number" && result > 0) return result;
      const record = result && typeof result === "object" ? (result as { priorityFeeEstimate?: unknown }) : null;
      const estimate = record?.priorityFeeEstimate;
      return typeof estimate === "number" && estimate > 0 ? estimate : 0;
    } catch {
      return 0;
    }
  }

  private async recent(accountKeys: readonly string[]): Promise<number> {
    try {
      const params = accountKeys.length > 0 ? [[...accountKeys]] : [];
      const result = await this.rpc("getRecentPrioritizationFees", params);
      if (!Array.isArray(result)) return 0;
      const fees = result.map((row) => {
        if (!row || typeof row !== "object") return 0;
        const fee = (row as { prioritizationFee?: unknown }).prioritizationFee;
        return typeof fee === "number" ? fee : 0;
      });
      return highPercentile(fees, PRIORITY_FEE_PERCENTILE);
    } catch {
      return 0;
    }
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await this.rpcFetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`rpc HTTP ${response.status}`);
    const payload = (await response.json()) as RpcEnvelope;
    if (payload.error) throw new Error(payload.error.message ?? "rpc error");
    return payload.result;
  }
}
