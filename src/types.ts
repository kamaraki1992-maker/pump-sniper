export type Mode = "paper" | "live";

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
  | "trailing_stop";

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
}

export type MarketEvent = MarketLaunch | MarketTrade;

export interface OrderRequest {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  /** SOL notionals for buys. Ignored for sells, which close 100%. */
  sizeSol: number;
  /** Stream mark in SOL per token, before this order's slippage. */
  quotePriceSol: number;
  slippagePct: number;
  reason: TradeReason;
  tokenAmount?: number;
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
  price: number;
  feesSol: number;
  jitoTipSol: number;
  signature: string;
  solscan: string | null;
  reason: TradeReason;
  error: string | null;
  solUsd: number | null;
  tokenAmount: number;
  /** Present on sells. Net proceeds minus the position cost basis. */
  realizedPnlSol: number | null;
  costSol: number | null;
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
  /** Highest mark seen. Drives the profit-lock floor. */
  peakPriceSol?: number | null;
  /** Locked floor in percent above entry. Only ratchets up. */
  trailFloorPct?: number | null;
  /** Trades applied to this position. Zero means the trade subscription delivered nothing. */
  tradesSeen?: number;
}

export interface Executor {
  buy(order: OrderRequest): Promise<FillResult>;
  sell(order: OrderRequest): Promise<FillResult>;
}
