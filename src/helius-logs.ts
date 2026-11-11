import { PublicKey } from "@solana/web3.js";

const ZERO_KEY = new PublicKey(Buffer.alloc(32));
import { PUMP_PROGRAM_ID } from "./yellowstone.js";
import {
  normalizeTokenAmount,
  isInitialCurvePrice,
  priceFromReserves,
  TOTAL_SUPPLY_TOKENS,
  virtualSol,
  virtualTokens,
  WSOL_MINT,
} from "./pricing.js";
import type { MarketEvent, MarketLaunch, MarketTrade } from "./types.js";

/** Canonical pump.fun program. The feed mentions this account, not a guessed id. */
export const PUMP_LOG_PROGRAM = PUMP_PROGRAM_ID;

/** sha256("event:CreateEvent")[0..8] */
export const CREATE_EVENT_DISC = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
/** sha256("event:TradeEvent")[0..8] */
export const TRADE_EVENT_DISC = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
/** sha256("event:CompleteEvent")[0..8] */
export const COMPLETE_EVENT_DISC = Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]);
/** sha256("event:CreatePoolEvent")[0..8] on the PumpSwap program. */
export const PUMP_SWAP_CREATE_DISC = Buffer.from([177, 49, 12, 210, 160, 118, 167, 116]);
/** sha256("event:BuyEvent")[0..8] */
export const PUMP_SWAP_BUY_DISC = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
/** sha256("event:SellEvent")[0..8] */
export const PUMP_SWAP_SELL_DISC = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);

/** Pool address to base mint. Survives across notifications in one process. */
const pumpSwapPools = new Map<string, { mint: string; quoteMint: string }>();

const ZERO_PUBKEY = ZERO_KEY.toBase58();

export interface LogsNotice {
  slot: number;
  signature: string;
  err: unknown;
  logs: string[];
}

interface CreateFields {
  name: string;
  symbol: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string;
  vSolRaw: number | null;
  vTokenRaw: number | null;
  quoteMint: string | null;
  uri: string;
}

interface TradeFields {
  mint: string;
  solLamports: number;
  tokenRaw: number;
  isBuy: boolean;
  user: string;
  vSolRaw: number;
  vTokenRaw: number;
  creator: string | null;
  venue?: "pumpswap";
  poolBaseTokens?: number | null;
  poolQuoteSol?: number | null;
}

class Cursor {
  constructor(private readonly buf: Buffer, private offset = 0) {}

  remaining(): number {
    return this.buf.length - this.offset;
  }

  read(length: number): Buffer | null {
    if (this.remaining() < length) return null;
    const out = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  u32(): number | null {
    const raw = this.read(4);
    if (!raw) return null;
    return raw.readUInt32LE(0);
  }

  u64(): number | null {
    const raw = this.read(8);
    if (!raw) return null;
    return Number(raw.readBigUInt64LE(0));
  }

  i64(): number | null {
    const raw = this.read(8);
    if (!raw) return null;
    return Number(raw.readBigInt64LE(0));
  }

  bool(): boolean | null {
    const raw = this.read(1);
    if (!raw) return null;
    return raw[0] !== 0;
  }

  pubkey(): string | null {
    const raw = this.read(32);
    if (!raw) return null;
    return new PublicKey(raw).toBase58();
  }

  text(max: number): string | null {
    const length = this.u32();
    if (length === null || length > max || this.remaining() < length) return null;
    const raw = this.read(length);
    if (!raw) return null;
    return raw.toString("utf8");
  }
}

function sameDisc(buf: Buffer, disc: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(disc);
}

/** Old layout ends at the virtual reserves. Longer layouts append real reserves, fees, and creator. */
export function decodeTradeEvent(data: Buffer): TradeFields | null {
  if (!sameDisc(data, TRADE_EVENT_DISC)) return null;
  const cur = new Cursor(data, 8);
  const mint = cur.pubkey();
  const solLamports = cur.u64();
  const tokenRaw = cur.u64();
  const isBuy = cur.bool();
  const user = cur.pubkey();
  if (cur.i64() === null) return null;
  const vSolRaw = cur.u64();
  const vTokenRaw = cur.u64();
  if (!mint || solLamports === null || tokenRaw === null || isBuy === null || !user || vSolRaw === null || vTokenRaw === null) {
    return null;
  }
  let creator: string | null = null;
  if (cur.remaining() >= 16) {
    cur.u64();
    cur.u64();
  }
  if (cur.remaining() >= 32 + 8 + 8 + 32) {
    cur.pubkey();
    cur.u64();
    cur.u64();
    creator = cur.pubkey();
  }
  return { mint, solLamports, tokenRaw, isBuy, user, vSolRaw, vTokenRaw, creator };
}

export function decodeCreateEvent(data: Buffer): CreateFields | null {
  if (!sameDisc(data, CREATE_EVENT_DISC)) return null;
  const cur = new Cursor(data, 8);
  const name = cur.text(32);
  const symbol = cur.text(13);
  const uri = cur.text(200);
  const mint = cur.pubkey();
  const bondingCurve = cur.pubkey();
  const user = cur.pubkey();
  if (name === null || symbol === null || uri === null || !mint || !bondingCurve || !user) return null;
  const creator = cur.remaining() >= 32 ? cur.pubkey() : null;
  if (cur.remaining() >= 8) cur.i64();
  const vTokenRaw = cur.remaining() >= 8 ? cur.u64() : null;
  const vSolRaw = cur.remaining() >= 8 ? cur.u64() : null;
  if (cur.remaining() >= 8) cur.u64();
  if (cur.remaining() >= 8) cur.u64();
  if (cur.remaining() >= 32) cur.pubkey();
  if (cur.remaining() >= 1) cur.bool();
  if (cur.remaining() >= 1) cur.bool();
  const quoteMint = cur.remaining() >= 32 ? cur.pubkey() : null;
  return {
    name,
    symbol,
    mint,
    bondingCurve,
    user,
    creator: creator ?? user,
    vSolRaw,
    vTokenRaw,
    quoteMint,
    uri,
  };
}

/**
 * PumpSwap CreatePool, Buy, and Sell events. The buy/sell layout stores pool
 * reserves at the same offset. The mint comes from a CreatePool seen earlier.
 * A known discriminator that is too short to parse is a failure.
 */
export function decodePumpSwap(
  data: Buffer,
  pools: Map<string, { mint: string; quoteMint: string }>,
): TradeFields | "fail" | null {
  if (sameDisc(data, PUMP_SWAP_CREATE_DISC)) {
    const cur = new Cursor(data, 8);
    if (cur.i64() === null || cur.read(2) === null) return "fail";
    if (!cur.pubkey()) return "fail";
    const mint = cur.pubkey();
    const quote = cur.pubkey();
    if (!mint || !quote || cur.read(2) === null) return "fail";
    if (cur.u64() === null || cur.u64() === null) return "fail";
    const baseRaw = cur.u64();
    const quoteRaw = cur.u64();
    if (baseRaw === null || quoteRaw === null) return "fail";
    for (let i = 0; i < 3; i += 1) if (cur.u64() === null) return "fail";
    if (cur.read(1) === null) return "fail";
    const pool = cur.pubkey();
    if (!pool) return "fail";
    pools.set(pool, { mint, quoteMint: quote });
    return null;
  }
  const buy = sameDisc(data, PUMP_SWAP_BUY_DISC);
  const sell = sameDisc(data, PUMP_SWAP_SELL_DISC);
  if (!buy && !sell) return null;
  const cur = new Cursor(data, 8);
  if (cur.i64() === null) return "fail";
  if (cur.u64() === null || cur.u64() === null || cur.u64() === null || cur.u64() === null) return "fail";
  const baseRaw = cur.u64();
  const quoteRaw = cur.u64();
  if (baseRaw === null || quoteRaw === null || !(baseRaw > 0)) return "fail";
  for (let i = 0; i < 7; i += 1) if (cur.u64() === null) return "fail";
  const pool = cur.pubkey();
  const user = cur.pubkey();
  if (!pool || !user) return "fail";
  const known = pools.get(pool);
  if (!known || !solQuoted(known.quoteMint)) return null;
  const priceSol = quoteRaw / 1e9 / (baseRaw / 1e6);
  return {
    mint: known.mint,
    solLamports: 0,
    tokenRaw: 0,
    isBuy: buy,
    user,
    vSolRaw: quoteRaw,
    vTokenRaw: baseRaw,
    creator: null,
    venue: "pumpswap",
    poolBaseTokens: baseRaw / 1e6,
    poolQuoteSol: quoteRaw / 1e9,
    ...(priceSol > 0 ? {} : {}),
  };
}

function decodeCompleteMint(data: Buffer): string | null {
  if (!sameDisc(data, COMPLETE_EVENT_DISC)) return null;
  const cur = new Cursor(data, 8);
  if (!cur.pubkey()) return null;
  return cur.pubkey();
}

function programData(line: string): Buffer | null {
  const match = /^Program data:\s*([A-Za-z0-9+/=]+)\s*$/.exec(line);
  if (!match?.[1]) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

export function readLogsNotice(message: unknown): LogsNotice | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  const method = record.method;
  const params = record.params as { result?: { context?: { slot?: number }; value?: { signature?: string; err?: unknown; logs?: unknown } } } | undefined;
  if (method !== "logsNotification" || !params?.result?.value) return null;
  const value = params.result.value;
  const logs = Array.isArray(value.logs) ? value.logs.filter((line): line is string => typeof line === "string") : [];
  const signature = typeof value.signature === "string" ? value.signature : "";
  if (!signature) return null;
  return {
    slot: typeof params.result.context?.slot === "number" ? params.result.context.slot : 0,
    signature,
    err: value.err ?? null,
    logs,
  };
}

function reservesOf(vSolRaw: number | null, vTokenRaw: number | null): {
  vSolSol: number | null;
  vTokens: number | null;
  priceSol: number | null;
  marketCapSol: number | null;
} {
  const vSolSol = vSolRaw === null ? null : virtualSol(vSolRaw);
  const vTokens = vTokenRaw === null ? null : virtualTokens(vTokenRaw);
  const priceSol = vSolRaw !== null && vTokenRaw !== null ? priceFromReserves(vSolRaw, vTokenRaw) : null;
  const marketCapSol = priceSol !== null ? priceSol * TOTAL_SUPPLY_TOKENS : null;
  return { vSolSol, vTokens, priceSol, marketCapSol };
}

function initialReserves(vSolRaw: number, vTokenRaw: number): boolean {
  const price = priceFromReserves(vSolRaw, vTokenRaw);
  return price != null && isInitialCurvePrice(price);
}

function solQuoted(quoteMint: string | null): boolean {
  return quoteMint === null || quoteMint === ZERO_PUBKEY || quoteMint === WSOL_MINT;
}

/**
 * Turn one logs notification into launch, trade, and graduation events.
 * Failed transactions are skipped. Unknown program-data lines are ignored.
 * A short or corrupt known event counts as a decode failure.
 */
export function eventsFromLogs(
  notice: LogsNotice,
  pools: Map<string, { mint: string; quoteMint: string }> = pumpSwapPools,
): { events: MarketEvent[]; failures: number } {
  if (notice.err != null) return { events: [], failures: 0 };
  const creates: CreateFields[] = [];
  const trades: TradeFields[] = [];
  const completes: string[] = [];
  let failures = 0;
  for (const line of notice.logs) {
    const data = programData(line);
    if (!data) continue;
    if (sameDisc(data, CREATE_EVENT_DISC)) {
      const decoded = decodeCreateEvent(data);
      if (!decoded) failures += 1;
      else creates.push(decoded);
      continue;
    }
    if (sameDisc(data, TRADE_EVENT_DISC)) {
      const decoded = decodeTradeEvent(data);
      if (!decoded) failures += 1;
      else trades.push(decoded);
      continue;
    }
    if (sameDisc(data, COMPLETE_EVENT_DISC)) {
      const mint = decodeCompleteMint(data);
      if (!mint) failures += 1;
      else completes.push(mint);
      continue;
    }
    const swapped = decodePumpSwap(data, pools);
    if (swapped === "fail") failures += 1;
    else if (swapped) trades.push(swapped);
  }
  const events: MarketEvent[] = [];
  for (const created of creates) {
    if (!solQuoted(created.quoteMint) || created.vSolRaw === 0) continue;
    const devBuys = trades.filter(
      (trade) => trade.mint === created.mint && trade.isBuy && (trade.user === created.creator || trade.user === created.user),
    );
    const boughtRaw = devBuys.reduce((sum, trade) => sum + trade.tokenRaw, 0);
    const boughtSol = devBuys.reduce((sum, trade) => sum + trade.solLamports, 0);
    // CreateEvent reserves are the curve before the create buy. The trade in the
    // same transaction is the post-buy state, and that is the price we keep.
    const moved = trades.find(
      (trade) => trade.mint === created.mint && trade.vSolRaw > 0 && trade.vTokenRaw > 0 && !initialReserves(trade.vSolRaw, trade.vTokenRaw),
    );
    const reserves = moved
      ? reservesOf(moved.vSolRaw, moved.vTokenRaw)
      : reservesOf(created.vSolRaw, created.vTokenRaw);
    const launch: MarketLaunch = {
      kind: "launch",
      mint: created.mint,
      name: created.name,
      symbol: created.symbol,
      creator: created.creator,
      signature: notice.signature,
      initialBuyTokens: normalizeTokenAmount(boughtRaw),
      quoteMint: created.quoteMint === ZERO_PUBKEY ? null : created.quoteMint,
      solQuoted: true,
      priceSol: reserves.priceSol,
      marketCapSol: reserves.marketCapSol,
      vSolSol: reserves.vSolSol,
      vTokens: reserves.vTokens,
      bondingCurveKey: created.bondingCurve,
      metadataUri: created.uri || null,
      slot: notice.slot,
      solAmount: boughtSol > 0 ? boughtSol / 1e9 : null,
    };
    events.push(launch);
  }
  for (const trade of trades) {
    if (!(trade.vSolRaw > 0) || !(trade.vTokenRaw > 0)) continue;
    // A create tx can include a trade that still reports the untouched curve.
    // That print is the pre-buy snapshot, not a later market, so it is not emitted.
    if (initialReserves(trade.vSolRaw, trade.vTokenRaw) && creates.some((created) => created.mint === trade.mint)) {
      continue;
    }
    const reserves = trade.venue === "pumpswap" ? null : reservesOf(trade.vSolRaw, trade.vTokenRaw);
    const poolPrice =
      trade.poolBaseTokens != null && trade.poolBaseTokens > 0 && trade.poolQuoteSol != null
        ? trade.poolQuoteSol / trade.poolBaseTokens
        : null;
    const row: MarketTrade = {
      kind: "trade",
      mint: trade.mint,
      txType: trade.isBuy ? "buy" : "sell",
      trader: trade.user,
      signature: notice.signature,
      solQuoted: true,
      priceSol: trade.venue === "pumpswap" ? poolPrice : reserves?.priceSol ?? null,
      marketCapSol: trade.venue === "pumpswap" ? (poolPrice != null ? poolPrice * TOTAL_SUPPLY_TOKENS : null) : reserves?.marketCapSol ?? null,
      vSolSol: reserves?.vSolSol ?? null,
      vTokens: reserves?.vTokens ?? null,
      slot: notice.slot,
      solAmount: trade.solLamports > 0 ? trade.solLamports / 1e9 : null,
      ...(trade.venue ? { venue: trade.venue, poolBaseTokens: trade.poolBaseTokens, poolQuoteSol: trade.poolQuoteSol } : {}),
    };
    events.push(row);
  }
  for (const mint of completes) {
    events.push({ kind: "graduation", mint, pool: null, baseTokens: null, quoteSol: null });
  }
  return { events, failures };
}
