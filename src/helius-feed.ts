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
  terminate?(): void;
  ping?(): void;
  removeAllListeners?(): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  on(event: "pong", cb: () => void): void;
}

function defaultSocket(url: string): HeliusSocket {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    terminate: () => ws.terminate(),
    ping: () => ws.ping(),
    removeAllListeners: () => {
      ws.removeAllListeners();
    },
    on: (event, cb) => {
      ws.on(event, cb as never);
    },
  };
}

export interface HeliusFeedOptions {
  stallMs?: number;
  /** Give up on a socket that has not opened and confirmed logsSubscribe. */
  connectTimeoutMs?: number;
  now?: () => number;
  sockets?: (url: string) => HeliusSocket;
  backoff?: (attempt: number) => number;
  /** How often to publish the per-minute counters. */
  statsMs?: number;
  pingMs?: number;
}

const CONNECT_TIMEOUT_MS = 10_000;
const STALL_CHECK_MS = 5_000;

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
  private connectTimer: NodeJS.Timeout | null = null;
  /** Last logs notification or subscribe confirmation. Pongs do not update this. */
  private lastActivityAt = 0;
  private hadActivity = false;
  private subscribed = false;
  private connectStartedAt = 0;
  private downSince: number | null = null;
  private reconnectDueAt: number | null = null;
  private readonly tracked = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private onEvent: (event: MarketEvent) => void = () => {};
  private readonly stallMs: number;
  private readonly connectTimeoutMs: number;
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
    this.stallMs = options.stallMs ?? 30_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
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
    const socket = this.ws;
    this.ws = null;
    this.opened = false;
    this.subscribed = false;
    if (socket) this.kill(socket);
  }

  /**
   * Reconnect when the feed is silent, the socket never finishes connecting,
   * or a scheduled reconnect does not run. This keeps running while the
   * socket is down so a missed close event cannot stick.
   */
  checkStall(): void {
    if (this.stopped) return;
    const now = this.now();
    if (this.timer) {
      if (this.reconnectDueAt != null && now >= this.reconnectDueAt + 1_000) {
        clearTimeout(this.timer);
        this.timer = null;
        this.reconnectDueAt = null;
        this.log.info("helius stall", { silentMs: this.silentMs(), state: "reconnect" });
        this.markDown();
        this.schedule("stuck-reconnect");
      }
      return;
    }
    const socket = this.ws;
    if (!socket || !this.opened || !this.subscribed) {
      if (!socket) {
        this.markDown();
        this.schedule("disconnected");
        return;
      }
      const waited = now - this.connectStartedAt;
      if (waited < this.connectTimeoutMs) return;
      this.log.info("helius stall", { silentMs: waited, state: "connecting" });
      this.dropAndSchedule(socket, "connect-timeout");
      return;
    }
    const silent = now - this.lastActivityAt;
    if (silent < this.stallMs) return;
    this.log.info("helius stall", { silentMs: silent, state: "silent" });
    this.dropAndSchedule(socket, "stall");
  }

  private armTimers(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      if (this.opened) this.ws?.ping?.();
    }, this.pingMs);
    this.stallTimer = setInterval(() => this.checkStall(), Math.min(this.stallMs, STALL_CHECK_MS));
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
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.timer = null;
    this.pingTimer = null;
    this.stallTimer = null;
    this.statsTimer = null;
    this.connectTimer = null;
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
      this.schedule("socket");
      return;
    }
    this.ws = socket;
    this.opened = false;
    this.subscribed = false;
    this.connectStartedAt = this.now();
    this.armConnectTimer();
    socket.on("open", () => {
      if (this.ws !== socket) return;
      this.opened = true;
      this.attempt = 0;
      this.send(this.subscribeBody());
      this.log.info("helius open", { url: redactRpcUrl(this.url), commitment: HELIUS_LOG_COMMITMENT });
    });
    socket.on("message", (data) => {
      if (this.ws !== socket) return;
      this.onMessage(data);
    });
    socket.on("pong", () => {
      // Protocol pongs are not feed activity. Silence is measured from logs.
    });
    socket.on("error", (error) => {
      this.log.error("helius ws error", { error: error instanceof Error ? error.message : "ws-error" });
      if (this.ws !== socket) return;
      this.dropAndSchedule(socket, "error");
    });
    socket.on("close", () => {
      if (this.stopped || this.ws !== socket) return;
      this.opened = false;
      this.subscribed = false;
      this.ws = null;
      this.markDown();
      this.schedule("close");
    });
  }

  private armConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.checkStall();
    }, this.connectTimeoutMs);
    this.connectTimer.unref?.();
  }

  /** Last real feed message. Zero until the first logs notification or subscribe ack. */
  private silentMs(): number {
    if (!this.hadActivity) return Math.max(0, this.now() - this.connectStartedAt);
    return Math.max(0, this.now() - this.lastActivityAt);
  }

  private markDown(): void {
    if (this.downSince != null) return;
    this.downSince = this.hadActivity ? this.lastActivityAt : this.now();
  }

  private noteActivity(): void {
    this.lastActivityAt = this.now();
    this.hadActivity = true;
  }

  /** A subscribe ack or a logs notification means this socket is usable. */
  private noteSubscribed(): void {
    this.opened = true;
    this.subscribed = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.downSince == null) return;
    const downtimeMs = Math.max(0, this.now() - this.downSince);
    this.downSince = null;
    this.log.info("helius resubscribed", { downtimeMs });
  }

  /** Drop handlers, kill the socket, and reconnect without waiting for close. */
  private dropAndSchedule(socket: HeliusSocket, reason: string): void {
    if (this.stopped || this.ws !== socket) return;
    this.opened = false;
    this.subscribed = false;
    this.ws = null;
    this.markDown();
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.detach(socket);
    this.kill(socket);
    this.schedule(reason);
  }

  private detach(socket: HeliusSocket): void {
    socket.removeAllListeners?.();
  }

  private kill(socket: HeliusSocket): void {
    try {
      if (socket.terminate) socket.terminate();
      else socket.close();
    } catch (error) {
      this.log.error("helius socket failed", {
        error: error instanceof Error ? error.message : "socket-error",
      });
    }
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
    const record = parsed as { error?: { message?: string }; id?: number; result?: unknown; method?: unknown };
    if (record.error) {
      this.log.error("helius logsSubscribe rejected", {
        warning: "The RPC refused logsSubscribe. Not falling back to another feed.",
        error: typeof record.error.message === "string" ? record.error.message.slice(0, 240) : "rpc-error",
      });
      return;
    }
    if (record.method == null && record.id === 1 && record.result !== undefined) {
      this.noteActivity();
      this.noteSubscribed();
      return;
    }
    const notice = readLogsNotice(parsed);
    if (!notice) return;
    this.noteActivity();
    this.noteSubscribed();
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

  private schedule(reason: string): void {
    if (this.stopped || this.timer) return;
    const delay = this.backoff(this.attempt);
    this.attempt += 1;
    this.reconnectDueAt = this.now() + delay;
    this.log.info("helius reconnect", { attempt: this.attempt, delayMs: delay, reason });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reconnectDueAt = null;
      this.open();
    }, delay);
    this.timer.unref?.();
  }
}
