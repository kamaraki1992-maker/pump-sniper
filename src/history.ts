import { PublicKey } from "@solana/web3.js";
import type { AppConfig } from "./config.js";
import { marketCapSolFromCurveData, type CurveMark, type FilterDecision, type HistoryTx } from "./filter.js";
import { historyDecision } from "./filter.js";
import { Logger } from "./logger.js";
import { WSOL_MINT } from "./pricing.js";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

interface RpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

interface SignatureInfo {
  signature: string;
  err: unknown;
  blockTime: number | null;
}

interface TokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount?: { uiAmount: number | null };
}

interface RawTx {
  blockTime: number | null;
  meta: {
    err: unknown;
    logMessages?: string[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
}

/** Recent signatures are enough to see a dev dump. A batch of 25 was a 429 storm. */
const HISTORY_SIGNATURE_LIMIT = 8;
const HISTORY_MISS_TTL_MS = 5 * 60_000;
const HISTORY_HIT_TTL_MS = 10 * 60_000;

export class RpcCreatorHistory {
  private readonly cache = new Map<string, { at: number; decision: FilterDecision }>();
  private readonly inflight = new Map<string, Promise<FilterDecision>>();

  constructor(
    private readonly config: AppConfig,
    log: Logger,
    private readonly now: () => number = Date.now,
    private readonly rpcFetch: typeof fetch = fetch,
  ) {
    void log;
  }

  async lookup(creator: string): Promise<FilterDecision> {
    if (!creator) return { ok: false, reason: "creator-history-unavailable" };
    const cached = this.cached(creator);
    if (cached) return cached;
    const pending = this.inflight.get(creator);
    if (pending) return pending;
    const run = this.fetch(creator)
      .then((decision) => {
        this.cache.set(creator, { at: this.now(), decision });
        return decision;
      })
      .catch(() => {
        const decision: FilterDecision = { ok: false, reason: "creator-history-unavailable" };
        this.cache.set(creator, { at: this.now(), decision });
        return decision;
      })
      .finally(() => {
        this.inflight.delete(creator);
      });
    this.inflight.set(creator, run);
    return run;
  }

  private cached(creator: string): FilterDecision | null {
    const cached = this.cache.get(creator);
    if (!cached) return null;
    const unavailable = cached.decision.ok === false && cached.decision.reason === "creator-history-unavailable";
    const ttl = unavailable ? HISTORY_MISS_TTL_MS : HISTORY_HIT_TTL_MS;
    if (this.now() - cached.at >= ttl) return null;
    return cached.decision;
  }

  private async fetch(creator: string): Promise<FilterDecision> {
    try {
      const signatures = await this.signatures(creator);
      if (signatures.length === 0) return { ok: true };
      const txs = await this.transactions(signatures);
      const views = txs
        .filter((tx): tx is RawTx & { meta: NonNullable<RawTx["meta"]> } => {
          return tx !== null && tx.meta !== null && tx.meta.err == null;
        })
        .map((tx) => toHistoryTx(tx, creator))
        .filter((tx): tx is HistoryTx => tx !== null);
      const curves = await this.curves(views);
      return historyDecision(views, curves, Math.floor(this.now() / 1000));
    } catch {
      // The shared limiter already retried HTTP 429. A miss is a skip, not a crash.
      return { ok: false, reason: "creator-history-unavailable" };
    }
  }

  private async signatures(creator: string): Promise<SignatureInfo[]> {
    const body = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
      creator,
      { limit: HISTORY_SIGNATURE_LIMIT },
    ]);
    return (body ?? []).filter((row) => row.err == null).slice(0, HISTORY_SIGNATURE_LIMIT);
  }

  private async transactions(signatures: SignatureInfo[]): Promise<Array<RawTx | null>> {
    const batch = signatures.map((row, index) => ({
      jsonrpc: "2.0",
      id: index,
      method: "getTransaction",
      params: [
        row.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ],
    }));
    const response = await this.post(batch);
    const payload = (await response.json()) as Array<RpcResponse<RawTx | null>>;
    if (!Array.isArray(payload)) throw new Error("rpc batch was not an array");
    const byId = new Map<number, RawTx | null>();
    for (const item of payload) {
      const id = (item as { id?: number }).id;
      if (typeof id === "number") byId.set(id, item.result ?? null);
    }
    return signatures.map((_, index) => byId.get(index) ?? null);
  }

  private async curves(views: HistoryTx[]): Promise<CurveMark[]> {
    const list = [...new Set(views.map((tx) => tx.createdMint).filter((mint): mint is string => Boolean(mint)))].slice(0, 3);
    if (list.length === 0) return [];
    const keys = list.map((mint) =>
      PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP_PROGRAM)[0].toBase58(),
    );
    const accounts = multipleAccounts(
      await this.rpc<unknown>("getMultipleAccounts", [keys, { encoding: "base64" }]),
    );
    const marks: CurveMark[] = [];
    accounts.forEach((account, index) => {
      const mint = list[index];
      const encoded = account?.data?.[0];
      if (!mint || !encoded) return;
      const mc = marketCapSolFromCurveData(Buffer.from(encoded, "base64"));
      if (mc !== null) marks.push({ mint, marketCapSol: mc });
    });
    return marks;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T | null> {
    const response = await this.post({ jsonrpc: "2.0", id: 1, method, params });
    const payload = (await response.json()) as RpcResponse<T>;
    if (payload.error) throw new Error(payload.error.message ?? "rpc error");
    return payload.result ?? null;
  }

  private async post(body: unknown): Promise<Response> {
    const response = await this.rpcFetch(this.config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`rpc HTTP ${response.status}`);
    return response;
  }
}

export function multipleAccounts(result: unknown): Array<{ data?: [string, string] } | null> {
  if (Array.isArray(result)) return result as Array<{ data?: [string, string] } | null>;
  if (result && typeof result === "object" && "value" in result && Array.isArray(result.value)) {
    return result.value as Array<{ data?: [string, string] } | null>;
  }
  return [];
}

function toHistoryTx(tx: RawTx & { meta: NonNullable<RawTx["meta"]> }, creator: string): HistoryTx | null {
  if (tx.blockTime === null) return null;
  const pre = new Map<string, number>();
  const post = new Map<string, number>();
  for (const row of tx.meta.preTokenBalances ?? []) {
    if (row.owner !== creator || row.mint === WSOL_MINT) continue;
    pre.set(row.mint, row.uiTokenAmount?.uiAmount ?? 0);
  }
  for (const row of tx.meta.postTokenBalances ?? []) {
    if (row.owner !== creator || row.mint === WSOL_MINT) continue;
    post.set(row.mint, row.uiTokenAmount?.uiAmount ?? 0);
  }
  const balances = [...new Set([...pre.keys(), ...post.keys()])].map((mint) => ({
    mint,
    preUi: pre.get(mint) ?? 0,
    postUi: post.get(mint) ?? 0,
  }));
  const logs = tx.meta.logMessages ?? [];
  const created = logs.some((line) => /Instruction: Create(?:V2)?\b/.test(line));
  return {
    blockTimeSec: tx.blockTime,
    logs,
    createdMint: created ? largestMint(tx.meta.postTokenBalances ?? []) : null,
    balances,
  };
}

function largestMint(rows: TokenBalance[]): string | null {
  let best: { mint: string; amount: number } | null = null;
  for (const row of rows) {
    if (row.mint === WSOL_MINT) continue;
    const amount = row.uiTokenAmount?.uiAmount ?? 0;
    if (!best || amount > best.amount) best = { mint: row.mint, amount };
  }
  return best?.mint ?? null;
}
