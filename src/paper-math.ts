import type { PaperModel } from "./config.js";

export interface PaperBuy {
  fillPriceSol: number;
  tokenAmount: number;
  feesSol: number;
  jitoTipSol: number;
  /** SOL that leaves the wallet: order size + priority + base fee + tip. */
  costSol: number;
  sizeSol: number;
}

export interface PaperSell {
  fillPriceSol: number;
  /** Net SOL credited after protocol/venue fees, priority, base fee, and tip. */
  proceedsSol: number;
  feesSol: number;
  jitoTipSol: number;
  sizeSol: number;
}

function feeRate(model: PaperModel): number {
  return (model.protocolFeeBps + model.venueFeeBps) / 10_000;
}

function overhead(model: PaperModel): number {
  return model.priorityFeeSol + model.baseFeeSol + model.jitoTipSol;
}

/**
 * Buy: the order size is the SOL swapped. Protocol and venue fees reduce the
 * tokens received. Slippage worsens the fill. Priority fee, base fee, and the
 * Jito tip are extra SOL that leaves the wallet.
 */
export function paperBuy(quotePriceSol: number, sizeSol: number, model: PaperModel): PaperBuy {
  const slip = model.slippagePct / 100;
  const fillPriceSol = quotePriceSol * (1 + slip);
  const rate = feeRate(model);
  const tokenAmount = fillPriceSol > 0 ? (sizeSol * (1 - rate)) / fillPriceSol : 0;
  const swapFeeSol = sizeSol * rate;
  const feesSol = swapFeeSol + model.priorityFeeSol + model.baseFeeSol;
  return {
    fillPriceSol,
    tokenAmount,
    feesSol,
    jitoTipSol: model.jitoTipSol,
    costSol: sizeSol + overhead(model),
    sizeSol,
  };
}

/** Sell the whole token balance. Slippage and fees worsen the SOL proceeds. */
export function paperSell(quotePriceSol: number, tokenAmount: number, model: PaperModel): PaperSell {
  const slip = model.slippagePct / 100;
  const fillPriceSol = quotePriceSol * (1 - slip);
  const gross = tokenAmount * fillPriceSol;
  const rate = feeRate(model);
  const swapFeeSol = gross * rate;
  const proceedsSol = gross - swapFeeSol - overhead(model);
  const feesSol = swapFeeSol + model.priorityFeeSol + model.baseFeeSol;
  return {
    fillPriceSol,
    proceedsSol,
    feesSol,
    jitoTipSol: model.jitoTipSol,
    sizeSol: proceedsSol,
  };
}

export function unrealizedPnlSol(
  tokenAmount: number,
  costSol: number,
  markPriceSol: number,
  model: PaperModel,
): number {
  if (!(markPriceSol > 0) || !(tokenAmount > 0)) return -costSol;
  return paperSell(markPriceSol, tokenAmount, model).proceedsSol - costSol;
}
