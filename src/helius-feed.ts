import WebSocket from "ws";
import { Logger } from "./logger.js";
import { nextBackoffMs } from "./stream.js";
import { eventsFromLogs, PUMP_LOG_PROGRAM, readLogsNotice } from "./helius-logs.js";
import { redactRpcUrl } from "./redact.js";
import type { MarketEvent } from "./types.js";

/**
 * logsSubscribe commitment. Helius accepts `processed`, and the entry window
 * plus stop exits need the print before the tx is confirmed.
 */
export const HELIUS_LOG_COMMITMENT = "processed";

export interface HeliusSocket {
  send(data: string): void;
  close(): void;
  ping?(): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (error: Error) => void): void;
}

function defaultSocket(url: string): HeliusSocket {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    ping: () => ws.ping(),
    on: (event, cb) => {
      ws.on(event, cb as never);
    },
  };
}

export interface HeliusFeedOptions {
  stallMs?: number;
  now?: () => number;
  sockets?: (url: string) => HeliusSocket;
  backoff?: (attempt: number) => number;
  /** How often to publish the per-minute counters. */
  statsMs?: number;
  pingMs?: number;
}

/**
 * One Helius logsSubscribe for the pump program. Token trades are filtered
 * locally to mints the bot is watching. There is no per-token subscription.
 */
export class HeliusFeed {
  private ws: HeliusSocket | null = null;
  private opened = false;
  private stopped = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private readonly tracked = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private onEvent: (event: MarketEvent) => void = () => {};
  private readonly stallMs: number;
  private readonly now: () => number;
  private readonly sockets: (url: string) => HeliusSocket;
  private readonly backoff: (attempt: number) => number;
  private readonly statsMs: number;
  private readonly pingMs: number;
  private window = { events: 0, decodeFailures: 0, failedTx: 0, dupes: 0 };

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    options: HeliusFeedOptions = {},
  ) {
    this.stallMs = options.stallMs ?? 45_000;
    this.now = options.now ?? Date.now;
    this.sockets = options.sockets ?? defaultSocket;
    this.backoff = options.backoff ?? nextBackoffMs;
    this.statsMs = options.statsMs ?? 60_000;
    this.pingMs = options.pingMs ?? 20_000;
  }

  start(onEvent: (event: MarketEvent) => void): void {
    this.onEvent = onEvent;
    this.stopped = false;
    if (!this.url.trim()) {
      this.log.error("helius feed needs RPC_WS_URL", {
        warning: "FEED=helius is selected and RPC_WS_URL is empty. Not falling back to another feed.",
      });
      return;
    }
    this.open();
    this.armTimers();
  }

  /** Record a mint locally. The program subscription already delivers its logs. */
  subscribeTrades(mints: string[]): void {
    for (const mint of mints) {
      if (mint) this.tracked.add(mint);
    }
  }

  unsubscribeTrades(mints: string[]): void {
    for (const mint of mints) this.tracked.delete(mint);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.opened = false;
  }

  /** Reconnect when the socket has been silent longer than the stall window. */
  checkStall(): void {
    if (this.stopped || !this.opened) return;
    const silent = this.now() - this.lastMessageAt;
    if (silent < this.stallMs) return;
    this.log.info("helius stall", { silentMs: silent });
    this.opened = false;
    this.ws?.close();
  }

  private armTimers(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      if (this.opened) this.ws?.ping?.();
    }, this.pingMs);
    this.stallTimer = setInterval(() => this.checkStall(), Math.min(this.stallMs, 5_000));
    this.statsTimer = setInterval(() => this.publishStats(), this.statsMs);
    this.pingTimer.unref?.();
    this.stallTimer.unref?.();
    this.statsTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.stallTimer) clearInterval(this.stallTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.timer = null;
    this.pingTimer = null;
    this.stallTimer = null;
    this.statsTimer = null;
  }

  private publishStats(): void {
    const events = this.window.events;
    const decodeFailures = this.window.decodeFailures;
    if (events === 0 && decodeFailures === 0 && this.window.failedTx === 0 && this.window.dupes === 0) return;
    this.log.info("helius feed", {
      eventsPerMin: events,
      decodeFailures,
      failedTx: this.window.failedTx,
      dupes: this.window.dupes,
      tracked: this.tracked.size,
    });
    this.window = { events: 0, decodeFailures: 0, failedTx: 0, dupes: 0 };
  }

  private open(): void {
    if (this.stopped || !this.url.trim()) return;
    this.opened = false;
    let socket: HeliusSocket;
    try {
      socket = this.sockets(this.url);
    } catch (error) {
      this.log.error("helius socket failed", {
        error: error instanceof Error ? error.message : "socket-error",
        url: redactRpcUrl(this.url),
      });
      this.schedule();
      return;
    }
    this.ws = socket;
    let scheduled = false;
    const reconnect = () => {
      if (this.stopped || scheduled || this.ws !== socket) return;
      scheduled = true;
      this.opened = false;
      const delay = this.backoff(this.attempt);
      this.attempt += 1;
      this.log.info("helius reconnect", { delayMs: delay });
      this.timer = setTimeout(() => this.open(), delay);
      this.timer.unref?.();
    };
    socket.on("open", () => {
      if (this.ws !== socket) return;
      this.opened = true;
      this.attempt = 0;
      this.lastMessageAt = this.now();
      this.send(this.subscribeBody());
      this.log.info("helius open", { url: redactRpcUrl(this.url), commitment: HELIUS_LOG_COMMITMENT });
    });
    socket.on("message", (data) => {
      if (this.ws !== socket) return;
      this.lastMessageAt = this.now();
      this.onMessage(data);
    });
    socket.on("error", (error) => {
      this.log.error("helius ws error", { error: error instanceof Error ? error.message : "ws-error" });
      reconnect();
    });
    socket.on("close", () => reconnect());
  }

  private subscribeBody(): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [{ mentions: [PUMP_LOG_PROGRAM] }, { commitment: HELIUS_LOG_COMMITMENT }],
    });
  }

  private onMessage(data: unknown): void {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.window.decodeFailures += 1;
      return;
    }
    const record = parsed as { error?: { message?: string }; id?: number; result?: unknown };
    if (record.error) {
      this.log.error("helius logsSubscribe rejected", {
        warning: "The RPC refused logsSubscribe. Not falling back to another feed.",
        error: typeof record.error.message === "string" ? record.error.message.slice(0, 240) : "rpc-error",
      });
      return;
    }
    const notice = readLogsNotice(parsed);
    if (!notice) return;
    if (notice.err != null) {
      this.window.failedTx += 1;
      return;
    }
    if (this.seen.has(notice.signature)) {
      this.window.dupes += 1;
      return;
    }
    this.remember(notice.signature);
    let decoded: ReturnType<typeof eventsFromLogs>;
    try {
      decoded = eventsFromLogs(notice);
    } catch {
      this.window.decodeFailures += 1;
      return;
    }
    this.window.decodeFailures += decoded.failures;
    const created = new Set(decoded.events.filter((event) => event.kind === "launch").map((event) => event.mint));
    for (const event of decoded.events) {
      if (event.kind === "trade" && !this.tracked.has(event.mint) && !created.has(event.mint)) continue;
      this.window.events += 1;
      try {
        this.onEvent(event);
      } catch (error) {
        this.log.info("helius event failed", { error: error instanceof Error ? error.message : "event-error" });
      }
    }
  }

  private remember(signature: string): void {
    this.seen.add(signature);
    this.seenOrder.push(signature);
    if (this.seenOrder.length > 4_000) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
  }

  private send(payload: string): void {
    try {
      this.ws?.send(payload);
    } catch (error) {
      this.log.error("helius send failed", { error: error instanceof Error ? error.message : "send-error" });
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    const delay = this.backoff(this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
    this.timer.unref?.();
  }
}
