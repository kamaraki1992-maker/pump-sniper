import type { PaperModel } from "./config.js";
import { paperBuy, paperSell } from "./paper-math.js";
import type { Executor, FillResult, OrderRequest } from "./types.js";

function failed(order: OrderRequest, error: string): FillResult {
  return {
    status: "failed",
    signature: "paper",
    solscan: null,
    price: 0,
    sizeSol: order.sizeSol,
    tokenAmount: 0,
    feesSol: 0,
    jitoTipSol: 0,
    cashflowSol: 0,
    error,
  };
}

function capped(model: PaperModel, cap: number): PaperModel {
  if (!(cap >= 0) || !Number.isFinite(cap)) return model;
  return { ...model, slippagePct: Math.min(model.slippagePct, cap) };
}

/** Simulated fills. This executor never signs or broadcasts. */
export class PaperExecutor implements Executor {
  constructor(private readonly model: PaperModel) {}

  async buy(order: OrderRequest): Promise<FillResult> {
    if (!(order.quotePriceSol > 0) || !(order.sizeSol > 0)) {
      return failed(order, "no-price");
    }
    const fill = paperBuy(order.quotePriceSol, order.sizeSol, capped(this.model, order.slippagePct));
    return {
      status: "filled",
      signature: "paper",
      solscan: null,
      price: fill.fillPriceSol,
      sizeSol: fill.sizeSol,
      tokenAmount: fill.tokenAmount,
      feesSol: fill.feesSol,
      jitoTipSol: fill.jitoTipSol,
      cashflowSol: fill.costSol,
      error: null,
    };
  }

  async sell(order: OrderRequest): Promise<FillResult> {
    const tokens = order.tokenAmount ?? 0;
    if (!(order.quotePriceSol > 0) || !(tokens > 0)) {
      return failed(order, "no-price");
    }
    const fill = paperSell(order.quotePriceSol, tokens, capped(this.model, order.slippagePct));
    return {
      status: "filled",
      signature: "paper",
      solscan: null,
      price: fill.fillPriceSol,
      sizeSol: fill.proceedsSol,
      tokenAmount: tokens,
      feesSol: fill.feesSol,
      jitoTipSol: fill.jitoTipSol,
      cashflowSol: fill.proceedsSol,
      error: null,
    };
  }
}
