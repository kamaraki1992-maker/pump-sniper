import type { AppConfig } from "./config.js";
import type { FilterDecision } from "./filter.js";
import { holdDecision } from "./filter.js";
import { Logger } from "./logger.js";
import type { PositionBook } from "./positions.js";
import type { TradeLog } from "./report.js";
import { exitSignal } from "./risk.js";
import type { Executor, MarketLaunch, MarketTrade, OrderRequest, Position, TradeReason } from "./types.js";

export interface BotDeps {
  config: AppConfig;
  executor: Executor;
  history: { lookup(creator: string): Promise<FilterDecision> };
  positions: PositionBook;
  trades: TradeLog;
  log: Logger;
  solUsd: () => number | null;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  subscribeMint: (mint: string) => void;
}

export class SniperBot {
  private readonly seen = new Set<string>();
  private readonly selling = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private stopped = false;

  constructor(private readonly deps: BotDeps) {
    for (const position of deps.positions.list()) {
      this.seen.add(position.mint);
      deps.subscribeMint(position.mint);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async onLaunch(launch: MarketLaunch): Promise<void> {
    if (this.stopped) return;
    if (this.seen.has(launch.mint) || this.deps.positions.get(launch.mint)) return;
    this.seen.add(launch.mint);
    if (!launch.solQuoted) {
      this.skip(launch, "non-sol quote");
      return;
    }
    if (!launch.creator) {
      this.skip(launch, "missing-creator");
      return;
    }
    if (!(launch.priceSol && launch.priceSol > 0)) {
      this.skip(launch, "no-price");
      return;
    }
    const hold = holdDecision(launch.initialBuyTokens, this.deps.config.creatorMaxHoldPct);
    if (!hold.ok) {
      this.skip(launch, hold.reason ?? "creator-hold");
      return;
    }
    const history = await this.deps.history.lookup(launch.creator);
    if (!history.ok) {
      this.skip(launch, history.reason ?? "creator-history-unavailable");
      return;
    }
    if (this.stopped) return;

    const order: OrderRequest = {
      mint: launch.mint,
      name: launch.name,
      symbol: launch.symbol,
      creator: launch.creator,
      sizeSol: this.deps.config.buySizeSol,
      quotePriceSol: launch.priceSol,
      slippagePct: this.deps.config.maxSlippagePct,
      reason: "entry",
    };
    const fill = await this.deps.executor.buy(order);
    this.deps.trades.append({
      timestamp: this.deps.now().toISOString(),
      mode: this.deps.config.mode,
      side: "buy",
      status: fill.status,
      mint: launch.mint,
      name: launch.name,
      symbol: launch.symbol,
      sizeSol: fill.status === "filled" ? fill.sizeSol : order.sizeSol,
      price: fill.price,
      feesSol: fill.feesSol,
      jitoTipSol: fill.jitoTipSol,
      signature: fill.signature || (this.deps.config.mode === "paper" ? "paper" : ""),
      solscan: fill.solscan,
      reason: "entry",
      error: fill.error,
      solUsd: this.deps.solUsd(),
      tokenAmount: fill.tokenAmount,
      realizedPnlSol: null,
      costSol: fill.status === "filled" ? fill.cashflowSol : null,
    });
    if (fill.status !== "filled") {
      this.deps.log.info("buy failed", { mint: launch.mint, error: fill.error });
      return;
    }
    const position: Position = {
      mint: launch.mint,
      name: launch.name,
      symbol: launch.symbol,
      creator: launch.creator,
      tokenAmount: fill.tokenAmount,
      entryPriceSol: fill.price,
      costSol: fill.cashflowSol,
      feesSol: fill.feesSol,
      tipSol: fill.jitoTipSol,
      openedAt: this.deps.now().toISOString(),
      mode: this.deps.config.mode,
      entrySignature: fill.signature,
      lastMarkPriceSol: launch.priceSol,
    };
    this.deps.positions.open(position);
    this.deps.subscribeMint(launch.mint);
    this.deps.log.info("buy filled", {
      mint: launch.mint,
      name: launch.name,
      price: fill.price,
      tokenAmount: fill.tokenAmount,
      signature: fill.signature,
    });
  }

  async onTrade(trade: MarketTrade): Promise<void> {
    const position = this.deps.positions.get(trade.mint);
    if (!position || !(trade.priceSol && trade.priceSol > 0)) return;
    position.lastMarkPriceSol = trade.priceSol;
    if (this.selling.has(trade.mint)) return;
    const cooldown = this.cooldownUntil.get(trade.mint) ?? 0;
    if (this.deps.now().getTime() < cooldown) return;
    const signal = exitSignal(
      position.entryPriceSol,
      trade.priceSol,
      this.deps.config.takeProfitPct,
      this.deps.config.stopLossPct,
    );
    if (!signal) return;
    await this.sellPosition(position, signal, trade.priceSol);
  }

  async panicSell(): Promise<void> {
    const open = this.deps.positions.list();
    for (const position of open) {
      await this.sellPosition(position, "manual", position.lastMarkPriceSol);
    }
  }

  private async sellPosition(position: Position, reason: TradeReason, quote: number): Promise<void> {
    if (this.selling.has(position.mint)) return;
    this.selling.add(position.mint);
    const attempts = Math.max(1, this.deps.config.sellMaxAttempts);
    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const current = this.deps.positions.get(position.mint);
        if (!current) return;
        const fill = await this.deps.executor.sell({
          mint: current.mint,
          name: current.name,
          symbol: current.symbol,
          creator: current.creator,
          sizeSol: current.costSol,
          quotePriceSol: quote > 0 ? quote : current.lastMarkPriceSol,
          slippagePct: this.deps.config.maxSlippagePct,
          reason,
          tokenAmount: current.tokenAmount,
        });
        const realized = fill.status === "filled" ? fill.cashflowSol - current.costSol : null;
        this.deps.trades.append({
          timestamp: this.deps.now().toISOString(),
          mode: this.deps.config.mode,
          side: "sell",
          status: fill.status,
          mint: current.mint,
          name: current.name,
          symbol: current.symbol,
          sizeSol: fill.status === "filled" ? fill.sizeSol : 0,
          price: fill.price,
          feesSol: fill.feesSol,
          jitoTipSol: fill.jitoTipSol,
          signature: fill.signature || (this.deps.config.mode === "paper" ? "paper" : ""),
          solscan: fill.solscan,
          reason,
          error: fill.error,
          solUsd: this.deps.solUsd(),
          tokenAmount: current.tokenAmount,
          realizedPnlSol: realized,
          costSol: current.costSol,
        });
        if (fill.status === "filled") {
          this.deps.positions.close(current.mint);
          this.deps.log.info("sell filled", {
            mint: current.mint,
            reason,
            realizedPnlSol: realized,
            signature: fill.signature,
          });
          return;
        }
        this.deps.log.info("sell failed", {
          mint: current.mint,
          reason,
          attempt,
          error: fill.error,
        });
        if (attempt < attempts) await this.deps.sleep(250 * 2 ** (attempt - 1));
      }
      this.cooldownUntil.set(position.mint, this.deps.now().getTime() + 5_000);
    } finally {
      this.selling.delete(position.mint);
    }
  }

  private skip(launch: MarketLaunch, reason: string): void {
    this.deps.log.info("skip", {
      mint: launch.mint,
      name: launch.name,
      symbol: launch.symbol,
      creator: launch.creator,
      reason,
    });
  }
}
