import type { Candle } from "./rules.js";

const DEX = "https://api.dexscreener.com";
const GECKO = "https://api.geckoterminal.com/api/v2";
/** A Gecko trade page at this size that stays inside the window is incomplete. */
const TRADE_PAGE = 300;

export interface DexPair {
  mint: string;
  pairAddress: string;
  dexId: string;
  symbol: string;
  name: string;
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  buys5m: number;
  sells5m: number;
  pairCreatedAtMs: number | null;
  /** Token side of the pool, in display units. */
  baseAmount: number | null;
  /** Quote side of the pool, in quote-token units. */
  quoteAmount: number | null;
  quoteMint: string | null;
}

export interface TradeWindow {
  makers1h: number;
  makersComplete: boolean;
  buyVolume15mUsd: number;
  sellVolume15mUsd: number;
  volume15mComplete: boolean;
}

export interface MomentumMarket {
  candidates(): Promise<string[]>;
  pair(mint: string): Promise<DexPair | null>;
  candles(pairAddress: string, nowMs: number): Promise<Candle[]>;
  trades(pairAddress: string, nowMs: number): Promise<TradeWindow | null>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseSolanaMints(payload: unknown): string[] {
  const root = asRecord(payload);
  const list = Array.isArray(payload) ? payload : Array.isArray(root?.data) ? root.data : [];
  const mints: string[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row || row.chainId !== "solana") continue;
    const mint = typeof row.tokenAddress === "string" ? row.tokenAddress : null;
    if (mint) mints.push(mint);
  }
  return mints;
}

export function parseDexPair(payload: unknown, mint: string): DexPair | null {
  const root = asRecord(payload);
  const pairs = Array.isArray(root?.pairs) ? root.pairs : Array.isArray(payload) ? payload : [];
  let best: DexPair | null = null;
  for (const item of pairs) {
    const row = asRecord(item);
    if (!row || row.chainId !== "solana") continue;
    const base = asRecord(row.baseToken);
    const address = base && typeof base.address === "string" ? base.address : null;
    if (address !== mint) continue;
    const dexId = typeof row.dexId === "string" ? row.dexId : "";
    if (dexId !== "pumpswap" && dexId !== "raydium" && dexId !== "raydium-cpmm" && dexId !== "pump-amm") continue;
    const pairAddress = typeof row.pairAddress === "string" ? row.pairAddress : "";
    const liquidityRow = asRecord(row.liquidity);
    const liquidity = num(liquidityRow?.usd) ?? 0;
    const quoteToken = asRecord(row.quoteToken);
    const txns = asRecord(asRecord(row.txns)?.m5);
    const created = num(row.pairCreatedAt);
    const pair: DexPair = {
      mint,
      pairAddress,
      dexId,
      symbol: typeof base?.symbol === "string" ? base.symbol : "",
      name: typeof base?.name === "string" ? base.name : "",
      priceUsd: num(row.priceUsd) ?? 0,
      marketCapUsd: num(row.marketCap) ?? num(row.fdv) ?? 0,
      liquidityUsd: liquidity,
      volume5mUsd: num(asRecord(row.volume)?.m5) ?? 0,
      buys5m: num(txns?.buys) ?? 0,
      sells5m: num(txns?.sells) ?? 0,
      pairCreatedAtMs: created,
      baseAmount: num(liquidityRow?.base),
      quoteAmount: num(liquidityRow?.quote),
      quoteMint: typeof quoteToken?.address === "string" ? quoteToken.address : null,
    };
    if (!best || pair.liquidityUsd > best.liquidityUsd) best = pair;
  }
  return best;
}

export function parseGeckoCandles(payload: unknown): Candle[] {
  const list = asRecord(asRecord(asRecord(payload)?.data)?.attributes)?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const candles: Candle[] = [];
  for (const item of list) {
    if (!Array.isArray(item) || item.length < 6) continue;
    const tsRaw = num(item[0]);
    const open = num(item[1]);
    const high = num(item[2]);
    const low = num(item[3]);
    const close = num(item[4]);
    const volume = num(item[5]);
    if (tsRaw == null || open == null || high == null || low == null || close == null || volume == null) continue;
    candles.push({ ts: tsRaw < 1e12 ? tsRaw * 1000 : tsRaw, open, high, low, close, volume });
  }
  return candles.sort((a, b) => a.ts - b.ts);
}

export function parseGeckoTrades(payload: unknown, nowMs: number): TradeWindow {
  const root = asRecord(payload);
  const list = Array.isArray(root?.data) ? root.data : [];
  const hour = nowMs - 60 * 60 * 1000;
  const quarter = nowMs - 15 * 60 * 1000;
  const makers = new Set<string>();
  let oldest = nowMs;
  let buy = 0;
  let sell = 0;
  let oldest15 = nowMs;
  let rows15 = 0;
  for (const item of list) {
    const attrs = asRecord(asRecord(item)?.attributes);
    if (!attrs) continue;
    const stamp = Date.parse(typeof attrs.block_timestamp === "string" ? attrs.block_timestamp : "");
    if (!Number.isFinite(stamp)) continue;
    oldest = Math.min(oldest, stamp);
    const wallet = typeof attrs.tx_from_address === "string" ? attrs.tx_from_address : "";
    if (stamp >= hour && wallet) makers.add(wallet);
    if (stamp >= quarter) {
      rows15 += 1;
      oldest15 = Math.min(oldest15, stamp);
      const volume = num(attrs.volume_in_usd) ?? 0;
      const kind = typeof attrs.kind === "string" ? attrs.kind.toLowerCase() : "";
      if (kind === "sell") sell += volume;
      else if (kind === "buy") buy += volume;
    }
  }
  const truncated = list.length >= TRADE_PAGE;
  return {
    makers1h: makers.size,
    makersComplete: !truncated || oldest <= hour,
    buyVolume15mUsd: buy,
    sellVolume15mUsd: sell,
    volume15mComplete: rows15 === 0 || !truncated || oldest15 <= quarter,
  };
}

class TtlCache<T> {
  private readonly rows = new Map<string, { at: number; value: T }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(key: string): T | undefined {
    const row = this.rows.get(key);
    if (!row || this.now() - row.at > this.ttlMs) return undefined;
    return row.value;
  }

  set(key: string, value: T): void {
    this.rows.set(key, { at: this.now(), value });
  }
}

/**
 * DexScreener for pair stats and GeckoTerminal for candles and trades.
 * Responses are cached for one poll, and calls are spaced 250ms apart.
 */
export class HttpMomentumMarket implements MomentumMarket {
  private readonly cache: TtlCache<unknown>;
  private lastCall = 0;

  constructor(
    private readonly pollMs: number,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.cache = new TtlCache(pollMs, now);
  }

  async candidates(): Promise<string[]> {
    const [boosts, profiles] = await Promise.all([
      this.cached(`${DEX}/token-boosts/latest/v1`),
      this.cached(`${DEX}/token-profiles/latest/v1`),
    ]);
    return [...new Set([...parseSolanaMints(boosts), ...parseSolanaMints(profiles)])];
  }

  async pair(mint: string): Promise<DexPair | null> {
    const payload = await this.cached(`${DEX}/latest/dex/tokens/${mint}`);
    return parseDexPair(payload, mint);
  }

  async candles(pairAddress: string, _nowMs: number): Promise<Candle[]> {
    const payload = await this.cached(
      `${GECKO}/networks/solana/pools/${pairAddress}/ohlcv/minute?aggregate=5&limit=30&currency=usd`,
    );
    return parseGeckoCandles(payload);
  }

  async trades(pairAddress: string, nowMs: number): Promise<TradeWindow | null> {
    const payload = await this.cached(`${GECKO}/networks/solana/pools/${pairAddress}/trades`);
    if (payload == null) return null;
    return parseGeckoTrades(payload, nowMs);
  }

  private async cached(url: string): Promise<unknown> {
    const hit = this.cache.get(url);
    if (hit !== undefined) return hit;
    const wait = 250 - (this.now() - this.lastCall);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastCall = this.now();
    const response = await this.fetcher(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`market HTTP ${response.status}`);
    const payload: unknown = await response.json();
    this.cache.set(url, payload);
    return payload;
  }
}
