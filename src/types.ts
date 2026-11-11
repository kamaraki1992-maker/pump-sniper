export type Mode = "paper" | "live";

export type Strategy = "sniper" | "momentum" | "scalp";

export type TradeSide = "buy" | "sell";

export type TradeStatus = "filled" | "failed";

/** Operator-facing reason. Buys use `entry`. Panic-sell uses `manual`. */
export type TradeReason =
  | "entry"
  | "tp"
  | "sl"
  | "manual"
  | "timeout"
  | "liquidity_drop"
  | "volume_stall"
  | "sell_pressure"
  | "trailing_stop"
  | "dev_sell"
  | "fast_drop"
  | "early_no_momentum"
  | "profit_lock"
  | "no_socials_time_stop"
  | "momentum_sl"
  | "momentum_tp1"
  | "momentum_tp2"
  | "momentum_tp3"
  | "momentum_moonbag"
  | "momentum_stale"
  | "scalp_sl"
  | "scalp_tp"
  | "scalp_trail"
  | "scalp_fast"
  | "scalp_max_hold";

export interface MarketLaunch {
  kind: "launch";
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  signature: string;
  /** Display tokens (decimals applied). */
  initialBuyTokens: number;
  quoteMint: string | null;
  solQuoted: boolean;
  priceSol: number | null;
  marketCapSol: number | null;
  /** Virtual SOL reserves, in SOL. */
  vSolSol: number | null;
  /** Virtual token reserves, in display tokens. */
  vTokens: number | null;
  bondingCurveKey: string | null;
  /** Metadata JSON URL from the create event. */
  metadataUri?: string | null;
  slot?: number | null;
  solAmount?: number | null;
}

export interface MarketTrade {
  kind: "trade";
  mint: string;
  txType: "buy" | "sell";
  trader: string;
  signature: string;
  solQuoted: boolean;
  priceSol: number | null;
  marketCapSol: number | null;
  vSolSol: number | null;
  /** Virtual token reserves, in display tokens, when the trade carried them. */
  vTokens?: number | null;
  venue?: "curve" | "pumpswap";
  poolBaseTokens?: number | null;
  poolQuoteSol?: number | null;
  slot?: number | null;
  /** SOL this print swapped. Absent when the feed did not include it. */
  solAmount?: number | null;
}

/** Curve `complete` or PumpSwap `create_pool`. Pricing leaves the bonding curve. */
export interface MarketGraduation {
  kind: "graduation";
  mint: string;
  pool: string | null;
  baseTokens: number | null;
  quoteSol: number | null;
}

export type MarketEvent = MarketLaunch | MarketTrade | MarketGraduation;

export interface OrderRequest {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  /** SOL notionals for buys. Sells use `tokenAmount` and `sellFraction`. */
  sizeSol: number;
  /** Stream mark in SOL per token, before this order's slippage. */
  quotePriceSol: number;
  slippagePct: number;
  reason: TradeReason;
  tokenAmount?: number;
  /** Share of the remaining position to sell. 1 or omitted closes the position. */
  sellFraction?: number;
  /**
   * Graduated route. PumpPortal accepts `pump-amm`, `raydium`, and `auto`.
   * The Lightning bundle body forwards this field unchanged.
   */
  pool?: "pump" | "pump-amm" | "raydium" | "auto";
  /** When set, paper and live use this priority fee instead of the dynamic quote. */
  priorityFeeSol?: number;
  /** Momentum fee tier. Unset keeps the sniper quote. */
  feeLevel?: "medium" | "high";
  /** `false` sends a normal transaction. Unset keeps the Jito bundle. */
  useJito?: boolean;
  /** Live momentum. Refuse a public-RPC send when both Jito and the Helius sender fail. */
  mevRequired?: boolean;
  /** Computed Jito tip for this order. Falls back to the config tip when omitted. */
  tipSol?: number;
  /** Stop-like exits use this order's slippage instead of the smaller paper default. */
  useQuotedSlippage?: boolean;
  /** First attempt of an emergency sell. The live path uses the cached blockhash and fee. */
  hot?: boolean;
}

export interface FillResult {
  status: TradeStatus;
  signature: string;
  solscan: string | null;
  price: number;
  sizeSol: number;
  tokenAmount: number;
  feesSol: number;
  jitoTipSol: number;
  /** SOL that left the wallet on a buy, or net SOL credited on a sell. */
  cashflowSol: number;
  error: string | null;
}

export interface TradeRecord {
  timestamp: string;
  mode: Mode;
  side: TradeSide;
  status: TradeStatus;
  mint: string;
  name: string;
  symbol: string;
  sizeSol: number;
  /** USD notional of a buy. Null on sells. */
  sizeUsd?: number | null;
  /** Curved confidence score used to size a buy. Null on sells. */
  confidence?: number | null;
  /** Same score on a 0–100 scale. Null on sells. */
  entryScore?: number | null;
  price: number;
  feesSol: number;
  jitoTipSol: number;
  signature: string;
  solscan: string | null;
  reason: TradeReason;
  error: string | null;
  solUsd: number | null;
  tokenAmount: number;
  /** Present on sells. Net proceeds minus the cost allocated to this fill. */
  realizedPnlSol: number | null;
  /** Present on sells. This fill plus earlier partials on the same position. */
  realizedPnlTotalSol?: number | null;
  costSol: number | null;
  /** Mark that triggered a sell, before slippage. */
  triggerPriceSol?: number | null;
  /** Paper and live sells go out as a Jito bundle. */
  bundle?: "jito" | null;
  /** Buy had no verified socials and entered through the fast lane. */
  noSocials?: boolean;
  /** Itemized momentum paper costs. Absent on sniper rows. */
  costs?: TradeCosts;
  /** Momentum entry that opened the position. Copied onto its sells. */
  entryType?: "breakout" | "pullback" | null;
  /** Which rule set wrote the row. Older sniper rows omit it. */
  strategy?: "sniper" | "momentum" | "scalp";
}

export interface TradeCosts {
  baseFeeSol: number;
  priorityFeeSol: number;
  tipSol: number;
  swapFeeSol: number;
  priceImpactPct: number;
  /** Negative when rent is debited, positive when it is credited back. */
  ataRentSol: number;
  closeFeeSol: number;
}

export interface Position {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  tokenAmount: number;
  entryPriceSol: number;
  costSol: number;
  feesSol: number;
  tipSol: number;
  openedAt: string;
  mode: Mode;
  entrySignature: string;
  lastMarkPriceSol: number;
  entryVSolSol?: number | null;
  lastVSolSol?: number | null;
  /** Virtual token reserves, in display tokens, last accepted for this mint. */
  lastVTokens?: number | null;
  /** Real SOL reserves sampled from the bonding-curve account. */
  entryRealSolSol?: number | null;
  lastRealSolSol?: number | null;
  bondingCurve?: string | null;
  lastTradeAtMs?: number;
  /** Highest mark seen. Drives the trailing stop. */
  peakPriceSol?: number | null;
  /** Latched stop in SOL per token. Only ratchets up. Null until the trail arms. */
  trailStopPriceSol?: number | null;
  /** Price floor armed by the profit lock. Only ratchets up. */
  profitLockPriceSol?: number | null;
  /** Locked floor in percent above entry. Derived from `trailStopPriceSol`. */
  trailFloorPct?: number | null;
  /** True after the 2x partial has filled. The remainder rides the trail. */
  tp1Taken?: boolean;
  /** Realized SOL from partial sells already booked on this position. */
  realizedPnlSol?: number;
  /** Trades applied to this position. Zero means the trade subscription delivered nothing. */
  tradesSeen?: number;
  /** Bonding curve completed or a PumpSwap pool was observed. */
  graduated?: boolean;
  pool?: string | null;
  /** PumpSwap base reserve, display tokens. */
  poolBaseTokens?: number | null;
  /** PumpSwap quote reserve, SOL. */
  poolQuoteSol?: number | null;
  /** Graduated, but no pool reserves yet. Sells wait for the next pool quote. */
  unpriced?: boolean;
  /** Creator token balance last observed, in display tokens. A drop is a dev sell. */
  creatorTokens?: number | null;
  /** Entered without verified socials. Uses the no-socials time stop. */
  noSocials?: boolean;
  /** Managed by STRATEGY=momentum. The sniper exits do not apply. */
  momentum?: boolean;
  /** Token amount of the original fill. Partials are fractions of this. */
  momentumOriginalTokens?: number;
  momentumTp1Taken?: boolean;
  momentumTp2Taken?: boolean;
  momentumTp3Taken?: boolean;
  /** Graduated route sent on the Lightning bundle. */
  momentumPool?: "pump" | "pump-amm" | "raydium" | "auto";
  momentumEntryType?: "breakout" | "pullback";
  /** Which bot opened the position. */
  strategy?: "sniper" | "momentum" | "scalp";
  /** Scalp already sold the 60% take-profit. The rest is on the 10% trail. */
  scalpTpTaken?: boolean;
}

export interface Executor {
  buy(order: OrderRequest): Promise<FillResult>;
  sell(order: OrderRequest): Promise<FillResult>;
  /** Build a sell ahead of the stop so the hot path does not wait on RPC. */
  arm?(order: OrderRequest): Promise<void>;
}
