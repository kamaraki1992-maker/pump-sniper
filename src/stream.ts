import WebSocket from "ws";
import { Logger } from "./logger.js";
import { parsePumpDevMessage } from "./pricing.js";
import type { MarketEvent } from "./types.js";

export function nextBackoffMs(attempt: number, baseMs = 1000, capMs = 30_000): number {
  const exp = Math.min(20, Math.max(0, attempt));
  return Math.min(capMs, baseMs * 2 ** exp);
}

/**
 * PumpDev Solana socket. Control frames (`type`) are ignored. Subscriptions
 * are replayed after every reconnect.
 */
export class PumpDevStream {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly mints = new Set<string>();
  private onEvent: (event: MarketEvent) => void = () => {};

  constructor(
    private readonly url: string,
    private readonly log: Logger,
  ) {}

  start(onEvent: (event: MarketEvent) => void): void {
    this.onEvent = onEvent;
    this.stopped = false;
    this.open();
  }

  subscribeTrades(mints: string[]): void {
    const fresh = mints.filter((mint) => !this.mints.has(mint));
    for (const mint of fresh) this.mints.add(mint);
    if (fresh.length > 0) this.send({ method: "subscribeTokenTrade", keys: fresh });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
  }

  private open(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let scheduled = false;
    const reconnect = () => {
      if (this.stopped || scheduled || this.ws !== ws) return;
      scheduled = true;
      const delay = nextBackoffMs(this.attempt);
      this.attempt += 1;
      this.log.info("ws reconnect", { delayMs: delay });
      this.timer = setTimeout(() => this.open(), delay);
    };
    ws.on("open", () => {
      this.attempt = 0;
      this.send({ method: "subscribeNewToken" });
      if (this.mints.size > 0) {
        this.send({ method: "subscribeTokenTrade", keys: [...this.mints] });
      }
      this.log.info("ws open", { url: this.url });
    });
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const event = parsePumpDevMessage(parsed);
      if (event) this.onEvent(event);
    });
    ws.on("error", (error) => {
      this.log.info("ws error", { error: error.message });
      reconnect();
    });
    ws.on("close", () => reconnect());
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}
