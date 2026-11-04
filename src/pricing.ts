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

export function priceFromMarketCap(marketCapSol: number): number | null {
  if (!Number.isFinite(marketCapSol) || marketCapSol <= 0) return null;
  return marketCapSol / TOTAL_SUPPLY_TOKENS;
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

export function parsePumpDevMessage(raw: unknown): MarketEvent | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (typeof record.type === "string") return null;
  const txType = record.txType;
  const mint = asString(record.mint);
  if (!mint) return null;
  const quoteMint = asString(record.quoteMint);
  const priced = eventPrice(record);
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
      bondingCurveKey: asString(record.bondingCurveKey),
    };
    return launch;
  }

  if (txType === "buy" || txType === "sell") {
    const trade: MarketTrade = {
      kind: "trade",
      mint,
      txType,
      trader: asString(record.traderPublicKey) ?? "",
      signature: asString(record.signature) ?? "",
      solQuoted,
      priceSol: priced.priceSol,
      marketCapSol: priced.marketCapSol,
    };
    return trade;
  }
  return null;
}
