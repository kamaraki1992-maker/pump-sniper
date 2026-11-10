import { PublicKey } from "@solana/web3.js";
import WebSocket from "ws";
import { Logger } from "./logger.js";
import { redactRpcUrl } from "./redact.js";
import { nextBackoffMs } from "./stream.js";

export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const CURVE_COMMITMENT = "confirmed";

/**
 * Real SOL in the bonding-curve account. Layout after the 8-byte discriminator:
 * virtual token, virtual SOL, real token, real SOL (u64 lamports at offset 32).
 */
export function realSolFromCurveData(data: Uint8Array): number | null {
  if (data.byteLength < 40) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lamports = view.getBigUint64(32, true);
  const sol = Number(lamports) / 1e9;
  if (!Number.isFinite(sol) || sol < 0) return null;
  return sol;
}

/** Byte 48 is the bonding-curve `complete` flag. Set when the curve has migrated. */
export function curveCompleteFlag(data: Uint8Array): boolean {
  return data.byteLength > 48 && data[48] === 1;
}

/** Virtual SOL and virtual tokens from the same account. Price is sol/tokens, not real SOL. */
export function virtualReservesFromCurveData(data: Uint8Array): { vSol: number; vTokens: number } | null {
  if (data.byteLength < 24) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const vTokensRaw = Number(view.getBigUint64(8, true));
  const vSolLamports = Number(view.getBigUint64(16, true));
  if (!(vTokensRaw > 0) || !(vSolLamports > 0)) return null;
  return { vSol: vSolLamports / 1e9, vTokens: vTokensRaw / 1e6 };
}

/** getAccountInfo on the bonding curve. Null when the account or its reserves are missing. */
export async function fetchCurveReserves(
  rpcUrl: string,
  mint: string,
  fetcher: typeof fetch = fetch,
): Promise<{ vSol: number; vTokens: number } | null> {
  const curve = bondingCurveAddress(mint, null);
  if (!curve) return null;
  const response = await fetcher(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [curve, { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: { value?: { data?: [string, string] } | null };
  };
  if (payload.error) return null;
  const encoded = payload.result?.value?.data?.[0];
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  return virtualReservesFromCurveData(Buffer.from(encoded, "base64"));
}

export function bondingCurveAddress(mint: string, hinted: string | null): string | null {
  if (hinted && hinted.length > 0) return hinted;
  try {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
      PUMP_PROGRAM_ID,
    )[0].toBase58();
  } catch {
    return null;
  }
}

export interface RpcSocket {
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", cb: (...args: never[]) => void): void;
}

interface Watched {
  curve: string;
  subId: number | null;
}

/**
 * accountSubscribe on each open position's bonding curve. When the URL is
 * missing or the socket is down, callers keep the trade-stream liquidity check.
 */
export class RpcCurveWatch {
  private socket: RpcSocket | null = null;
  private attempt = 0;
  private opened = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private readonly byReq = new Map<number, string>();
  private readonly bySub = new Map<number, string>();
  private readonly watched = new Map<string, Watched>();

  constructor(
    private readonly url: string | null,
    private readonly log: Logger,
    private readonly onReserves: (
    mint: string,
    realSol: number,
    reserves: { vSol: number; vTokens: number } | null,
    complete?: boolean,
  ) => void,
    private readonly sockets: (url: string) => RpcSocket = defaultSocket,
    private readonly backoff: (attempt: number) => number = nextBackoffMs,
  ) {}

  start(): void {
    if (!this.url || this.stopped) return;
    this.connect();
  }

  watch(mint: string, curve: string): void {
    this.watched.set(mint, { curve, subId: null });
    if (this.opened) this.subscribeOne(mint);
  }

  unwatch(mint: string): void {
    const row = this.watched.get(mint);
    if (!row) return;
    if (row.subId !== null && this.opened && this.socket) {
      this.socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "accountUnsubscribe",
          params: [row.subId],
        }),
      );
      this.bySub.delete(row.subId);
    }
    this.watched.delete(mint);
  }

  isLive(mint: string): boolean {
    const row = this.watched.get(mint);
    return Boolean(this.opened && row && row.subId !== null);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.opened = false;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (!this.url || this.stopped) return;
    let socket: RpcSocket;
    try {
      socket = this.sockets(this.url);
    } catch (error) {
      this.log.info("rpc ws error", { error: this.safe(error) });
      this.schedule();
      return;
    }
    this.socket = socket;
    socket.on("open", () => {
      this.opened = true;
      this.attempt = 0;
      this.log.info("rpc ws open");
      for (const mint of this.watched.keys()) this.subscribeOne(mint);
    });
    socket.on("message", ((data: unknown) => this.onMessage(data)) as never);
    socket.on("close", (() => {
      this.opened = false;
      for (const row of this.watched.values()) row.subId = null;
      this.bySub.clear();
      this.byReq.clear();
      this.log.info("rpc ws closed");
      this.schedule();
    }) as never);
    socket.on("error", ((error: unknown) => {
      this.opened = false;
      this.log.info("rpc ws error", { error: this.safe(error) });
      this.schedule();
    }) as never);
  }

  private subscribeOne(mint: string): void {
    const row = this.watched.get(mint);
    if (!row || row.subId !== null || !this.opened || !this.socket) return;
    const id = this.nextId++;
    this.byReq.set(id, mint);
    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "accountSubscribe",
        params: [row.curve, { commitment: CURVE_COMMITMENT, encoding: "base64" }],
      }),
    );
  }

  private onMessage(data: unknown): void {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
    if (!text) return;
    let message: {
      id?: number;
      result?: unknown;
      method?: string;
      params?: { subscription?: number; result?: { value?: { data?: [string, string] } } };
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === "number" && typeof message.result === "number") {
      const mint = this.byReq.get(message.id);
      const row = mint ? this.watched.get(mint) : undefined;
      if (mint && row) {
        row.subId = message.result;
        this.bySub.set(message.result, mint);
      }
      return;
    }
    if (message.method !== "accountNotification") return;
    const sub = message.params?.subscription;
    if (typeof sub !== "number") return;
    const mint = this.bySub.get(sub);
    const encoded = message.params?.result?.value?.data?.[0];
    if (!mint || typeof encoded !== "string") return;
    const bytes = Buffer.from(encoded, "base64");
    const sol = realSolFromCurveData(bytes);
    if (sol === null) return;
    const complete = curveCompleteFlag(bytes);
    this.onReserves(mint, sol, virtualReservesFromCurveData(bytes), complete);
  }

  private schedule(): void {
    if (this.stopped || !this.url || this.timer) return;
    const delay = this.backoff(this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private safe(error: unknown): string {
    const message = error instanceof Error ? error.message : "rpc-ws-error";
    return redactRpcUrl(message);
  }
}

function defaultSocket(url: string): RpcSocket {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    on: (event, cb) => {
      ws.on(event, cb as never);
    },
  };
}
