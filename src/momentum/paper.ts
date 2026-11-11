import type { AppConfig } from "../config.js";
import { WSOL_MINT } from "../pricing.js";
import type { FillResult, TradeCosts } from "../types.js";

/** Rent-exempt minimum for a 165-byte SPL token account. */
export const ATA_RENT_LAMPORTS = 2_039_280;
export const ATA_RENT_SOL = ATA_RENT_LAMPORTS / 1e9;

export interface PoolReserves {
  baseTokens: number;
  quoteSol: number;
}

export interface SwapQuote {
  tokensOut: number;
  solOut: number;
  fillPriceSol: number;
  spotPriceSol: number;
  impactPct: number;
  swapFeeSol: number;
}

/** PumpSwap uses the LP+protocol bps. Raydium uses its own bps. */
export function swapFeeBps(config: AppConfig, dexId: string): number {
  const id = dexId.toLowerCase();
  if (id === "raydium" || id === "raydium-cpmm") return config.momentumRaydiumFeeBps;
  return config.momentumPumpswapFeeBps;
}

/**
 * Constant-product reserves. DexScreener's quote amount is SOL only when the
 * quote mint is wSOL. Other quote mints are not priced here.
 */
export function reservesFromPair(
  baseAmount: number | null,
  quoteAmount: number | null,
  quoteMint: string | null,
): PoolReserves | null {
  if (!(baseAmount != null && baseAmount > 0) || !(quoteAmount != null && quoteAmount > 0)) return null;
  if (quoteMint !== WSOL_MINT) return null;
  return { baseTokens: baseAmount, quoteSol: quoteAmount };
}

/** Fee is taken from the SOL in. Fill price includes that fee and the pool impact. */
export function constantProductBuy(reserves: PoolReserves, sizeSol: number, feeBps: number): SwapQuote | null {
  const { baseTokens: base, quoteSol: quote } = reserves;
  if (!(base > 0) || !(quote > 0) || !(sizeSol > 0) || feeBps < 0) return null;
  const swapFeeSol = sizeSol * (feeBps / 10_000);
  const net = sizeSol - swapFeeSol;
  if (!(net > 0)) return null;
  const k = base * quote;
  const newBase = k / (quote + net);
  const tokensOut = base - newBase;
  if (!(tokensOut > 0) || !Number.isFinite(tokensOut)) return null;
  const spotPriceSol = quote / base;
  const fillPriceSol = sizeSol / tokensOut;
  return {
    tokensOut,
    solOut: 0,
    fillPriceSol,
    spotPriceSol,
    impactPct: (fillPriceSol / spotPriceSol - 1) * 100,
    swapFeeSol,
  };
}

/** Fee is taken from the tokens in. `solOut` is what the pool pays after the fee. */
export function constantProductSell(reserves: PoolReserves, tokenAmount: number, feeBps: number): SwapQuote | null {
  const { baseTokens: base, quoteSol: quote } = reserves;
  if (!(base > 0) || !(quote > 0) || !(tokenAmount > 0) || feeBps < 0) return null;
  const netTokens = tokenAmount * (1 - feeBps / 10_000);
  if (!(netTokens > 0)) return null;
  const k = base * quote;
  const solOut = quote - k / (base + netTokens);
  const noFeeOut = quote - k / (base + tokenAmount);
  if (!(solOut > 0) || !Number.isFinite(solOut)) return null;
  const spotPriceSol = quote / base;
  const fillPriceSol = solOut / tokenAmount;
  return {
    tokensOut: tokenAmount,
    solOut,
    fillPriceSol,
    spotPriceSol,
    impactPct: (1 - fillPriceSol / spotPriceSol) * 100,
    swapFeeSol: Math.max(0, noFeeOut - solOut),
  };
}

function failed(error: string, sizeSol: number): { fill: FillResult; costs: TradeCosts } {
  const costs: TradeCosts = {
    baseFeeSol: 0,
    priorityFeeSol: 0,
    tipSol: 0,
    swapFeeSol: 0,
    priceImpactPct: 0,
    ataRentSol: 0,
    closeFeeSol: 0,
  };
  return {
    costs,
    fill: {
      status: "failed",
      signature: "paper",
      solscan: null,
      price: 0,
      sizeSol,
      tokenAmount: 0,
      feesSol: 0,
      jitoTipSol: 0,
      cashflowSol: 0,
      error,
    },
  };
}

export function momentumPaperBuy(input: {
  sizeSol: number;
  slippagePct: number;
  reserves: PoolReserves | null;
  feeBps: number;
  baseFeeSol: number;
  priorityFeeSol: number;
  tipSol: number;
}): { fill: FillResult; costs: TradeCosts } {
  if (!input.reserves) return failed("no_reserves", input.sizeSol);
  const quote = constantProductBuy(input.reserves, input.sizeSol, input.feeBps);
  if (!quote) return failed("no_reserves", input.sizeSol);
  if (quote.impactPct > input.slippagePct) return failed("price_impact", input.sizeSol);
  const costs: TradeCosts = {
    baseFeeSol: input.baseFeeSol,
    priorityFeeSol: input.priorityFeeSol,
    tipSol: input.tipSol,
    swapFeeSol: quote.swapFeeSol,
    priceImpactPct: quote.impactPct,
    ataRentSol: -ATA_RENT_SOL,
    closeFeeSol: 0,
  };
  const feesSol = quote.swapFeeSol + input.priorityFeeSol + input.baseFeeSol;
  return {
    costs,
    fill: {
      status: "filled",
      signature: "paper",
      solscan: null,
      price: quote.fillPriceSol,
      sizeSol: input.sizeSol,
      tokenAmount: quote.tokensOut,
      feesSol,
      jitoTipSol: input.tipSol,
      cashflowSol: input.sizeSol + input.priorityFeeSol + input.baseFeeSol + input.tipSol + ATA_RENT_SOL,
      error: null,
    },
  };
}

export function momentumPaperSell(input: {
  tokenAmount: number;
  slippagePct: number;
  reserves: PoolReserves | null;
  feeBps: number;
  baseFeeSol: number;
  priorityFeeSol: number;
  tipSol: number;
  /** Full exit pays the close-account fee and is credited the ATA rent. */
  closeAccount: boolean;
}): { fill: FillResult; costs: TradeCosts } {
  if (!input.reserves) return failed("no_reserves", 0);
  const quote = constantProductSell(input.reserves, input.tokenAmount, input.feeBps);
  if (!quote) return failed("no_reserves", 0);
  if (quote.impactPct > input.slippagePct) return failed("price_impact", 0);
  const closeFeeSol = input.closeAccount ? input.baseFeeSol : 0;
  const ataRentSol = input.closeAccount ? ATA_RENT_SOL : 0;
  const costs: TradeCosts = {
    baseFeeSol: input.baseFeeSol,
    priorityFeeSol: input.priorityFeeSol,
    tipSol: input.tipSol,
    swapFeeSol: quote.swapFeeSol,
    priceImpactPct: quote.impactPct,
    ataRentSol,
    closeFeeSol,
  };
  const feesSol = quote.swapFeeSol + input.priorityFeeSol + input.baseFeeSol + closeFeeSol;
  return {
    costs,
    fill: {
      status: "filled",
      signature: "paper",
      solscan: null,
      price: quote.fillPriceSol,
      sizeSol: quote.solOut,
      tokenAmount: input.tokenAmount,
      feesSol,
      jitoTipSol: input.tipSol,
      cashflowSol: quote.solOut - input.priorityFeeSol - input.baseFeeSol - input.tipSol - closeFeeSol + ataRentSol,
      error: null,
    },
  };
}

/** SOL bankroll for a USD paper start. Used once, when the balance file is created. */
export function solFromUsdBalance(usd: number, solUsd: number): number | null {
  if (!(usd > 0) || !(solUsd > 0)) return null;
  return usd / solUsd;
}
