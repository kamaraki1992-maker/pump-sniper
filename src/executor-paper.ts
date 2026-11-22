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

function capped(model: PaperModel, order: OrderRequest): PaperModel {
  const cap = order.slippagePct;
  const slip = order.useQuotedSlippage || !(cap >= 0) || !Number.isFinite(cap) ? cap : Math.min(model.slippagePct, cap);
  const tip = order.tipSol != null && order.tipSol >= 0 && Number.isFinite(order.tipSol) ? order.tipSol : model.jitoTipSol;
  return { ...model, slippagePct: slip, jitoTipSol: tip };
}

/** Simulated fills. This executor never signs or broadcasts. */
export class PaperExecutor implements Executor {
  constructor(
    private readonly model: PaperModel,
    private readonly feeSol?: (order: OrderRequest) => Promise<number>,
  ) {}

  async buy(order: OrderRequest): Promise<FillResult> {
    if (!(order.quotePriceSol > 0) || !(order.sizeSol > 0)) {
      return failed(order, "no-price");
    }
    const fill = paperBuy(order.quotePriceSol, order.sizeSol, await this.priced(order));
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
    const fill = paperSell(order.quotePriceSol, tokens, await this.priced(order));
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

  private async priced(order: OrderRequest): Promise<PaperModel> {
    const base = capped(this.model, order);
    if (order.priorityFeeSol != null && order.priorityFeeSol >= 0 && Number.isFinite(order.priorityFeeSol)) {
      return { ...base, priorityFeeSol: order.priorityFeeSol };
    }
    if (!this.feeSol) return base;
    try {
      const sol = await this.feeSol(order);
      if (!(sol >= 0) || !Number.isFinite(sol)) return base;
      return { ...base, priorityFeeSol: sol };
    } catch {
      return base;
    }
  }
}
