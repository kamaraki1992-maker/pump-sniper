import bs58 from "bs58";
import { Logger } from "./logger.js";
import { WSOL_MINT } from "./pricing.js";
import type { MarketEvent, MarketLaunch, MarketTrade } from "./types.js";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export interface GeyserTokenBalance {
  mint: string;
  uiAmount: number | null;
}

/**
 * Turn pump program logs plus token balances into the same events the
 * WebSocket adapter emits. Prices are left null when the geyser payload has
 * no bonding-curve reserves; callers still use the side for flow and stalls.
 */
export function eventsFromGeyserLogs(input: {
  signature: string;
  logs: string[];
  balances: GeyserTokenBalance[];
}): MarketEvent[] {
  const created = input.logs.some((line) => /Instruction: Create(?:V2)?\b/.test(line));
  const bought = input.logs.some((line) => /Instruction: Buy(?:V2)?\b/.test(line));
  const sold = input.logs.some((line) => /Instruction: Sell(?:V2)?\b/.test(line));
  const mint = largestMint(input.balances);
  if (!mint) return [];
  const solQuoted = input.balances.some((row) => row.mint === WSOL_MINT) || mint.endsWith("pump");
  if (created) {
    const launch: MarketLaunch = {
      kind: "launch",
      mint,
      name: "",
      symbol: "",
      creator: "",
      signature: input.signature,
      initialBuyTokens: 0,
      quoteMint: solQuoted ? WSOL_MINT : null,
      solQuoted,
      priceSol: null,
      marketCapSol: null,
      vSolSol: null,
      vTokens: null,
      bondingCurveKey: null,
    };
    return [launch];
  }
  if (!bought && !sold) return [];
  const trade: MarketTrade = {
    kind: "trade",
    mint,
    txType: sold && !bought ? "sell" : "buy",
    trader: "",
    signature: input.signature,
    solQuoted,
    priceSol: null,
    marketCapSol: null,
    vSolSol: null,
  };
  return [trade];
}

function largestMint(balances: GeyserTokenBalance[]): string | null {
  let best: { mint: string; amount: number } | null = null;
  for (const row of balances) {
    if (row.mint === WSOL_MINT) continue;
    const amount = row.uiAmount ?? 0;
    if (!best || amount > best.amount) best = { mint: row.mint, amount };
  }
  return best?.mint ?? null;
}

export function signatureToBase58(signature: Uint8Array): string {
  return bs58.encode(signature);
}

/**
 * Optional Yellowstone gRPC source. Constructed only when GRPC_URL and
 * GRPC_TOKEN are both set. Failures are logged and the socket is closed;
 * the process does not invent events.
 */
export class YellowstoneStream {
  private stopped = false;
  private stream: { end: () => void; write: (req: unknown) => void } | null = null;
  private readonly mints = new Set<string>();
  private onEvent: (event: MarketEvent) => void = () => {};

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly log: Logger,
  ) {}

  start(onEvent: (event: MarketEvent) => void): void {
    this.onEvent = onEvent;
    this.stopped = false;
    void this.open();
  }

  subscribeTrades(mints: string[]): void {
    for (const mint of mints) this.mints.add(mint);
  }

  unsubscribeTrades(mints: string[]): void {
    for (const mint of mints) this.mints.delete(mint);
  }

  stop(): void {
    this.stopped = true;
    this.stream?.end();
    this.stream = null;
  }

  private async open(): Promise<void> {
    try {
      const grpc = (await import("@triton-one/yellowstone-grpc")) as unknown as {
        default: new (
        endpoint: string,
        token: string | undefined,
        channelOptions: undefined,
      ) => {
        subscribe(): Promise<{
          on(event: "data", listener: (update: { transaction?: { transaction?: GeyserTx } }) => void): void;
          on(event: "error", listener: (error: Error) => void): void;
          write(request: unknown): void;
          end(): void;
        }>;
      };
      };
      const client = new grpc.default(this.url, this.token, undefined);
      const stream = await client.subscribe();
      if (this.stopped) {
        stream.end();
        return;
      }
      this.stream = stream;
      stream.on("error", (error: Error) => {
        this.log.info("grpc error", { error: error.message });
      });
      stream.on("data", (update: { transaction?: { transaction?: GeyserTx } }) => {
        const tx = update.transaction?.transaction;
        if (!tx?.meta || tx.meta.logMessagesNone) return;
        const events = eventsFromGeyserLogs({
          signature: signatureToBase58(tx.signature),
          logs: tx.meta.logMessages ?? [],
          balances: (tx.meta.postTokenBalances ?? []).map((row) => ({
            mint: row.mint,
            uiAmount: row.uiTokenAmount?.uiAmount ?? null,
          })),
        });
        for (const event of events) {
          if (event.kind === "trade" && !this.mints.has(event.mint)) continue;
          this.onEvent(event);
        }
      });
      stream.write({
        accounts: {},
        slots: {},
        transactions: {
          pump: {
            vote: false,
            failed: false,
            accountInclude: [PUMP_PROGRAM_ID],
            accountExclude: [],
            accountRequired: [],
          },
        },
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        blockFooter: {},
        accountsDataSlice: [],
        commitment: 1,
      });
      this.log.info("grpc open", { url: this.url });
    } catch (error) {
      this.log.info("grpc unavailable", {
        error: error instanceof Error ? error.message : "grpc-error",
      });
    }
  }
}

interface GeyserTx {
  signature: Uint8Array;
  meta?: {
    logMessages?: string[];
    logMessagesNone?: boolean;
    postTokenBalances?: Array<{ mint: string; uiTokenAmount?: { uiAmount: number } }>;
  };
}
