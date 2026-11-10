import type { MarketEvent, MarketLaunch, MarketTrade } from "./types.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const TOTAL_SUPPLY_TOKENS = 1_000_000_000;
export const TOKEN_DECIMALS = 6;

/** Raw 6-decimal token amounts are ~1e15. Display amounts for a launch are <= 1e9. */
export function normalizeTokenAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (amount > 1e12) return amount / 10 ** TOKEN_DECIMALS;
  return amount;
}

/**
 * Create events report virtual SOL as lamports (30e9) and virtual tokens as
 * raw base units (1.073e15). Some trade examples in the docs are already
 * normalized. Values above these cutoffs are treated as raw.
 */
export function priceFromReserves(vSol: number, vTokens: number): number | null {
  if (!Number.isFinite(vSol) || !Number.isFinite(vTokens) || vSol <= 0 || vTokens <= 0) {
    return null;
  }
  const sol = vSol > 1_000 ? vSol / 1e9 : vSol;
  const tokens = vTokens > 1e12 ? vTokens / 10 ** TOKEN_DECIMALS : vTokens;
  if (tokens <= 0) return null;
  return sol / tokens;
}

export function virtualSol(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return value > 1_000 ? value / 1e9 : value;
}

export function virtualTokens(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? value / 1e6 : value;
}

export function priceFromMarketCap(marketCapSol: number): number | null {
  if (!Number.isFinite(marketCapSol) || marketCapSol <= 0) return null;
  return marketCapSol / TOTAL_SUPPLY_TOKENS;
}

/** Initial pump.fun virtual reserves. k stays on this product for the life of the curve. */
export const INITIAL_VIRTUAL_SOL = 30;
export const INITIAL_VIRTUAL_TOKENS = 1_073_000_000;
export const PUMP_CURVE_K = INITIAL_VIRTUAL_SOL * INITIAL_VIRTUAL_TOKENS;
/** Spot before any buy: 30 / 1_073_000_000. */
export const INITIAL_CURVE_SPOT = INITIAL_VIRTUAL_SOL / INITIAL_VIRTUAL_TOKENS;

/** True when `price` is the untouched initial curve, within a relative 1e-6. */
export function isInitialCurvePrice(price: number): boolean {
  if (!(price > 0) || !Number.isFinite(price)) return false;
  return Math.abs(price - INITIAL_CURVE_SPOT) / INITIAL_CURVE_SPOT <= 1e-6;
}
/** One unconfirmed update may not move the mark by more than this multiple. */
export const MARK_JUMP_LIMIT = 5;
/** First seconds after entry: a print this large is still a real pump. 54x launch prints stay out. */
export const EARLY_MARK_JUMP_LIMIT = 10;
export const EARLY_MARK_MS = 15_000;

export function reservesOnCurve(vSol: number, vTokens: number): boolean {
  if (!(vSol > 0) || !(vTokens > 0) || !Number.isFinite(vSol) || !Number.isFinite(vTokens)) return false;
  const ratio = (vSol * vTokens) / PUMP_CURVE_K;
  return ratio >= 0.8 && ratio <= 1.25;
}

export function spotFromReserves(vSol: number, vTokens: number): number | null {
  if (!reservesOnCurve(vSol, vTokens)) return null;
  return vSol / vTokens;
}

/** Upward gaps above this multiple are rejected. Drops are kept so a stop can see them. */
function jumpsTooFar(previous: number | null, next: number, limit = MARK_JUMP_LIMIT): boolean {
  if (previous == null || !(previous > 0)) return false;
  return next / previous > limit;
}

function agrees(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return false;
  const ratio = a / b;
  return ratio >= 0.95 && ratio <= 1.05;
}

export interface MarkAssessment {
  /** False when the proposed print is rejected. The returned reserves are the ones still trusted. */
  accept: boolean;
  price: number | null;
  vSol: number | null;
  vTokens: number | null;
}

/**
 * Bonding-curve reserves that moved are the mark, including a fast pump or a
 * drop through a floor. A print that disagrees with reserves is ignored, except
 * during the first seconds, when a jump of at most 10x is a real pump whose
 * curve fields have not caught up. A 54x print against launch reserves is not.
 */
export function assessMark(input: {
  previous: number | null;
  proposed: number | null;
  vSol: number | null;
  vTokens: number | null;
  nextVSol?: number | null;
  nextVTokens?: number | null;
  /** Position is still inside EARLY_MARK_MS. Allows one unconfirmed pump. */
  early?: boolean;
}): MarkAssessment {
  const previous = input.previous != null && input.previous > 0 ? input.previous : null;
  let vSol = input.vSol;
  let vTokens = input.vTokens;
  const trustedSpot = vSol != null && vTokens != null ? spotFromReserves(vSol, vTokens) : null;
  const nextSol = input.nextVSol ?? null;
  const nextTok = input.nextVTokens ?? null;
  const nextSpot = nextSol != null && nextTok != null ? spotFromReserves(nextSol, nextTok) : null;
  if (nextSpot != null && nextSol != null && nextTok != null && trustedSpot != null) {
    const moved = Math.abs(nextSpot - trustedSpot) / trustedSpot > 1e-4;
    if (moved) return { accept: true, price: nextSpot, vSol: nextSol, vTokens: nextTok };
  }
  if (nextSpot != null && nextSol != null && nextTok != null && !jumpsTooFar(previous, nextSpot)) {
    vSol = nextSol;
    vTokens = nextTok;
  }
  const reservePrice = vSol != null && vTokens != null ? spotFromReserves(vSol, vTokens) : null;
  const proposed = input.proposed != null && input.proposed > 0 ? input.proposed : null;
  if (proposed != null && reservePrice != null && !agrees(proposed, reservePrice)) {
    const limit = input.early ? EARLY_MARK_JUMP_LIMIT : MARK_JUMP_LIMIT;
    if (input.early && !jumpsTooFar(previous, proposed, limit)) {
      return { accept: true, price: proposed, vSol: input.vSol, vTokens: input.vTokens };
    }
    return { accept: false, price: previous, vSol: input.vSol, vTokens: input.vTokens };
  }
  const candidate = reservePrice ?? proposed;
  if (candidate == null) return { accept: false, price: previous, vSol: input.vSol, vTokens: input.vTokens };
  const limit = input.early ? EARLY_MARK_JUMP_LIMIT : MARK_JUMP_LIMIT;
  if (jumpsTooFar(previous, candidate, limit)) {
    return { accept: false, price: previous, vSol: input.vSol, vTokens: input.vTokens };
  }
  return { accept: true, price: candidate, vSol, vTokens };
}

/** Average SOL per token for selling `tokenAmount` into a constant-product pool. */
export function constantProductSellPrice(
  base: number | null | undefined,
  quote: number | null | undefined,
  tokenAmount: number,
): number | null {
  if (base == null || quote == null || !(base > 0) || !(quote > 0) || !(tokenAmount > 0)) return null;
  const out = quote - (base * quote) / (base + tokenAmount);
  if (!(out > 0) || !Number.isFinite(out)) return null;
  return out / tokenAmount;
}

/**
 * Average SOL per token for buying `sizeSol` out of the constant-product curve.
 * This is the price impact of our own size. Slippage is applied by the paper model.
 */
export function curveBuyPrice(
  vSol: number | null | undefined,
  vTokens: number | null | undefined,
  sizeSol: number,
): number | null {
  if (vSol == null || vTokens == null || !reservesOnCurve(vSol, vTokens) || !(sizeSol > 0)) return null;
  const tokensOut = vTokens - (vSol * vTokens) / (vSol + sizeSol);
  if (!(tokensOut > 0) || !Number.isFinite(tokensOut)) return null;
  return sizeSol / tokensOut;
}

/** Average SOL per token for selling `tokenAmount` into the constant-product curve. */
export function curveSellPrice(vSol: number | null | undefined, vTokens: number | null | undefined, tokenAmount: number): number | null {
  if (vSol == null || vTokens == null || !reservesOnCurve(vSol, vTokens)) return null;
  return constantProductSellPrice(vTokens, vSol, tokenAmount);
}

/** PumpSwap spot. `baseTokens` is the display token reserve, `quoteSol` is the SOL reserve. */
export function poolSpot(baseTokens: number | null | undefined, quoteSol: number | null | undefined): number | null {
  if (baseTokens == null || quoteSol == null || !(baseTokens > 0) || !(quoteSol > 0)) return null;
  return quoteSol / baseTokens;
}

export function poolSellPrice(
  baseTokens: number | null | undefined,
  quoteSol: number | null | undefined,
  tokenAmount: number,
): number | null {
  return constantProductSellPrice(baseTokens, quoteSol, tokenAmount);
}

export interface PoolReserves {
  baseTokens: number | null;
  quoteSol: number | null;
  pool: string | null;
}

/** Pull PumpSwap reserves off a create_pool or pumpswap trade. Raw fields are lamports and base units. */
export function poolReservesFromRecord(record: Record<string, unknown>): PoolReserves {
  const pool = asString(record.pool) ?? asString(record.canonicalPool);
  const baseUi = asNumber(record.poolBaseReservesUi);
  const quoteUi = asNumber(record.poolQuoteReservesUi);
  if (baseUi != null && quoteUi != null && baseUi > 0 && quoteUi > 0) {
    return { baseTokens: baseUi, quoteSol: quoteUi, pool };
  }
  const baseRaw = asNumber(record.poolBaseReserves);
  const quoteRaw = asNumber(record.poolQuoteReserves);
  if (baseRaw != null && quoteRaw != null && baseRaw > 0 && quoteRaw > 0) {
    return { baseTokens: baseRaw / 1e6, quoteSol: quoteRaw / 1e9, pool };
  }
  return { baseTokens: null, quoteSol: null, pool };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function eventPrice(record: Record<string, unknown>): {
  priceSol: number | null;
  marketCapSol: number | null;
} {
  const marketCapSol = asNumber(record.marketCapSol);
  const fromCap = marketCapSol === null ? null : priceFromMarketCap(marketCapSol);
  if (fromCap !== null) return { priceSol: fromCap, marketCapSol };
  const vSol = asNumber(record.vSolInBondingCurve);
  const vTok = asNumber(record.vTokensInBondingCurve);
  if (vSol === null || vTok === null) return { priceSol: null, marketCapSol };
  return { priceSol: priceFromReserves(vSol, vTok), marketCapSol };
}

const NON_PUMP_POOLS = new Set(["raydium", "bonk", "moonshot", "meteora", "orca"]);
const NAMED_POOLS = new Set(["pump", "pumpswap", "pump-amm", ...NON_PUMP_POOLS]);

/**
 * PumpPortal's free data socket. Reserves are SOL and display tokens, the same
 * units `virtualSol` / `virtualTokens` already produce from PumpDev's raw fields.
 * `pool: "raydium"` and other non-pump venues are dropped. `pool: "pump"` stays
 * on the bonding curve.
 */
export function parsePumpPortalMessage(raw: unknown): MarketEvent | null {
  const record = asRecord(raw);
  if (!record || typeof record.type === "string") return null;
  const poolName = asString(record.pool)?.toLowerCase() ?? "";
  if (poolName && NON_PUMP_POOLS.has(poolName)) return null;
  const adjusted: Record<string, unknown> = { ...record };
  const named = poolName !== "" && NAMED_POOLS.has(poolName);
  const amm = poolName === "pumpswap" || poolName === "pump-amm";
  if (record.txType === "migrate") {
    if (poolName && poolName !== "pump" && !amm && named) return null;
    adjusted.txType = "create_pool";
  }
  if (amm || (!named && poolName !== "")) adjusted.source = adjusted.source ?? "pumpswap";
  if (named) delete adjusted.pool;
  return parsePumpDevMessage(adjusted);
}

export function parsePumpDevMessage(raw: unknown): MarketEvent | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (typeof record.type === "string") return null;
  const txType = record.txType;
  const mint = asString(record.mint);
  if (!mint) return null;
  const quoteMint = asString(record.quoteMint);
  const priced = eventPrice(record);
  const vSolSol = virtualSol(asNumber(record.vSolInBondingCurve));
  const vTokens = virtualTokens(asNumber(record.vTokensInBondingCurve));
  const solQuoted = quoteMint === WSOL_MINT || (quoteMint === null && priced.marketCapSol !== null);

  if (txType === "create") {
    const launch: MarketLaunch = {
      kind: "launch",
      mint,
      name: asString(record.name) ?? "",
      symbol: asString(record.symbol) ?? "",
      creator: asString(record.traderPublicKey) ?? "",
      signature: asString(record.signature) ?? "",
      initialBuyTokens: normalizeTokenAmount(asNumber(record.initialBuy) ?? 0),
      quoteMint,
      solQuoted,
      priceSol: priced.priceSol,
      marketCapSol: priced.marketCapSol,
      vSolSol,
      vTokens,
      bondingCurveKey: asString(record.bondingCurveKey),
      metadataUri: asString(record.uri),
      slot: asNumber(record.slot),
      solAmount: asNumber(record.solAmount),
    };
    return launch;
  }

  if (txType === "complete" || txType === "create_pool") {
    const pool = poolReservesFromRecord(record);
    return {
      kind: "graduation",
      mint,
      pool: pool.pool,
      baseTokens: pool.baseTokens,
      quoteSol: pool.quoteSol,
    };
  }

  if (txType === "buy" || txType === "sell") {
    const pool = poolReservesFromRecord(record);
    const pumpswap = record.source === "pumpswap";
    const trade: MarketTrade = {
      kind: "trade",
      mint,
      txType,
      trader: asString(record.traderPublicKey) ?? "",
      signature: asString(record.signature) ?? "",
      solQuoted,
      priceSol: priced.priceSol,
      marketCapSol: priced.marketCapSol,
      vSolSol,
      vTokens,
      ...(pumpswap ? { venue: "pumpswap" as const, poolBaseTokens: pool.baseTokens, poolQuoteSol: pool.quoteSol } : {}),
      slot: asNumber(record.slot),
      solAmount: asNumber(record.solAmount),
    };
    return trade;
  }
  return null;
}
