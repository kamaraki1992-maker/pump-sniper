import { requiredBuyBalanceSol, type AppConfig } from "./config.js";
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
  /** Live mode only. Paper mode does not consult a wallet. */
  walletBalanceSol?: () => Promise<number>;
}

const MAX_OPEN_LOG_MS = 5_000;

export class SniperBot {
  private readonly seen = new Set<string>();
  private readonly pendingBuys = new Set<string>();
  private readonly selling = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private lastMaxOpenLogMs = Number.NEGATIVE_INFINITY;
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
    if (this.occupied() >= this.deps.config.maxOpenPositions) {
      this.skipMaxOpen(launch);
      return;
    }
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
    if (!this.tryReserve(launch.mint)) {
      this.skipMaxOpen(launch);
      return;
    }

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
    try {
      if (this.deps.config.mode === "live") {
        const balance = await this.readBalance();
        const required = requiredBuyBalanceSol(this.deps.config);
        if (!(balance >= required)) {
          this.skip(launch, "insufficient_balance", { balanceSol: balance, requiredSol: required });
          return;
        }
      }
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
        openPositions: this.deps.positions.list().length,
      });
    } finally {
      this.pendingBuys.delete(launch.mint);
    }
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

  private occupied(): number {
    return this.deps.positions.list().length + this.pendingBuys.size;
  }

  private tryReserve(mint: string): boolean {
    if (this.occupied() >= this.deps.config.maxOpenPositions) return false;
    this.pendingBuys.add(mint);
    return true;
  }

  private async readBalance(): Promise<number> {
    try {
      const balance = await this.deps.walletBalanceSol?.();
      return typeof balance === "number" && Number.isFinite(balance) ? balance : 0;
    } catch (error) {
      this.deps.log.info("wallet balance failed", {
        error: error instanceof Error ? error.message : "balance-error",
      });
      return 0;
    }
  }

  private skipMaxOpen(launch: MarketLaunch): void {
    const now = this.deps.now().getTime();
    if (now - this.lastMaxOpenLogMs < MAX_OPEN_LOG_MS) return;
    this.lastMaxOpenLogMs = now;
    this.skip(launch, "max_open_positions", {
      openPositions: this.deps.positions.list().length,
      pendingBuys: this.pendingBuys.size,
    });
  }

  private skip(launch: MarketLaunch, reason: string, extra?: Record<string, unknown>): void {
    this.deps.log.info("skip", {
      mint: launch.mint,
      name: launch.name,
      symbol: launch.symbol,
      creator: launch.creator,
      reason,
      ...extra,
    });
  }
}
