import WebSocket from "ws";
import { Logger } from "./logger.js";
import { parsePumpDevMessage, parsePumpPortalMessage } from "./pricing.js";
import { redactRpcUrl } from "./redact.js";
import type { MarketEvent } from "./types.js";

/** Live token subscriptions PumpDev allows before an auth ack. */
export const ANONYMOUS_SUBSCRIPTION_LIMIT = 5;

const TIER_SUBSCRIPTION_LIMIT: Record<string, number> = {
  anonymous: ANONYMOUS_SUBSCRIPTION_LIMIT,
  free: 25,
  starter: 100,
  pro: 1_000,
  whale: 10_000,
};

export interface PumpDevOptions {
  /** Default in this class is pumpdev so existing callers keep the auth cap. The process default is pumpportal. */
  feed?: "pumpportal" | "pumpdev";
  apiKey?: string | null;
  /** Ceiling applied on top of the PumpDev tier limit. Ignored by the PumpPortal feed. */
  maxSubscriptions?: number;
}

/** PumpPortal accepts at most this many mint keys in one subscribe message. */
export const PORTAL_SUBSCRIBE_BATCH = 100;

export function nextBackoffMs(attempt: number, baseMs = 1000, capMs = 30_000): number {
  const exp = Math.min(20, Math.max(0, attempt));
  return Math.min(capMs, baseMs * 2 ** exp);
}

export interface PumpSocket {
  send(data: string): void;
  close(): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (error: Error) => void): void;
}

function defaultSocket(url: string): PumpSocket {
  return new WebSocket(url) as unknown as PumpSocket;
}

function payloadText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(data).toString();
  }
  return "";
}

/**
 * PumpDev Solana socket. Control frames (`type`) are ignored by the parser.
 * Token-trade subscriptions are replayed after every reconnect and dropped
 * when the caller unsubscribes, because the anonymous tier only allows a
 * handful of live keys. A PumpDev auth ack raises the cap to that tier's limit.
 */
export class PumpDevStream {
  private ws: PumpSocket | null = null;
  private opened = false;
  private attempt = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private retried = false;
  private subscriptionLimit = ANONYMOUS_SUBSCRIPTION_LIMIT;
  private readonly wanted = new Set<string>();
  /** Mints waiting for a free subscription slot. */
  private readonly queued = new Set<string>();
  private readonly acked = new Set<string>();
  /** Mints already sent on this socket. PumpPortal does not ack subscriptions. */
  private readonly sent = new Set<string>();
  private onEvent: (event: MarketEvent) => void = () => {};
  private readonly apiKey: string | null;
  /** PumpPortal trade subscriptions. Not sent on the URL and not logged. */
  private readonly portalKey: string | null;
  private portalKeyWarned = false;
  private readonly configuredMax: number | undefined;
  private readonly portal: boolean;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly sockets: (url: string) => PumpSocket = defaultSocket,
    private readonly backoff: (attempt: number) => number = nextBackoffMs,
    options: PumpDevOptions = {},
  ) {
    this.portal = options.feed === "pumpportal";
    const key = options.apiKey?.trim() ?? "";
    this.portalKey = this.portal && key.length > 0 ? key : null;
    this.apiKey = this.portal || key.length === 0 ? null : key;
    this.configuredMax = this.portal ? undefined : options.maxSubscriptions;
    if (this.portal) this.subscriptionLimit = Number.MAX_SAFE_INTEGER;
    else if (this.configuredMax != null) {
      this.subscriptionLimit = Math.min(ANONYMOUS_SUBSCRIPTION_LIMIT, this.configuredMax);
    }
  }

  start(onEvent: (event: MarketEvent) => void): void {
    this.onEvent = onEvent;
    this.stopped = false;
    this.open();
  }

  /** True once the server ack listed this mint. A send alone is not delivery. */
  tradeLive(mint: string): boolean {
    return this.wanted.has(mint) && this.acked.has(mint);
  }

  subscribeTrades(mints: string[]): void {
    let added = false;
    for (const mint of mints) {
      if (!mint || this.wanted.has(mint) || this.queued.has(mint)) continue;
      if (this.wanted.size >= this.subscriptionLimit) {
        this.queued.add(mint);
        this.log.info("subscription cap", { mint, limit: this.subscriptionLimit, tracked: this.wanted.size });
        continue;
      }
      this.wanted.add(mint);
      added = true;
    }
    if (added) this.flushPending();
  }

  unsubscribeTrades(mints: string[]): void {
    const drop: string[] = [];
    for (const mint of mints) {
      this.queued.delete(mint);
      this.sent.delete(mint);
      if (this.wanted.delete(mint)) {
        this.acked.delete(mint);
        drop.push(mint);
      }
    }
    if (drop.length > 0) this.send({ method: "unsubscribeTokenTrade", keys: drop });
    this.promote();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
  }

  private open(): void {
    if (this.stopped) return;
    this.opened = false;
    const ws = this.sockets(this.url);
    this.ws = ws;
    let scheduled = false;
    const reconnect = () => {
      if (this.stopped || scheduled || this.ws !== ws) return;
      scheduled = true;
      this.opened = false;
      const delay = this.backoff(this.attempt);
      this.attempt += 1;
      this.log.info("ws reconnect", { delayMs: delay });
      this.timer = setTimeout(() => this.open(), delay);
    };
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.opened = true;
      this.acked.clear();
      this.sent.clear();
      this.retried = false;
      if (this.apiKey) this.send({ method: "auth", key: this.apiKey });
      this.send({ method: "subscribeNewToken" });
      this.flushPending();
      this.log.info("ws open", { url: redactRpcUrl(this.url) });
    });
    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      try {
        const text = payloadText(data);
        if (!text) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (this.onPortalNotice(parsed)) return;
        if (this.onControl(parsed)) return;
        const event = this.portal ? parsePumpPortalMessage(parsed) : parsePumpDevMessage(parsed);
        if (event) this.onEvent(event);
      } catch (error) {
        this.log.info("ws message failed", {
          error: error instanceof Error ? error.message : "ws-message",
        });
      }
    });
    ws.on("error", (error) => {
      this.log.info("ws error", { error: error instanceof Error ? error.message : "ws-error" });
      reconnect();
    });
    ws.on("close", () => reconnect());
  }

  /** Returns true when the frame is a control message and should not be parsed as a trade. */
  private onControl(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const record = raw as Record<string, unknown>;
    if (typeof record.type !== "string") return false;
    if (record.type === "auth") {
      this.onAuth(record);
      return true;
    }
    if (record.type === "subscribed" && record.method === "subscribeTokenTrade") {
      const keys = Array.isArray(record.keys)
        ? record.keys.filter((key): key is string => typeof key === "string")
        : [];
      for (const key of keys) {
        if (this.wanted.has(key)) this.acked.add(key);
      }
      const missing = [...this.wanted].filter((mint) => !this.acked.has(mint));
      this.log.info("trade subscription", { applied: keys, missing });
      if (missing.length > 0 && !this.retried) {
        this.retried = true;
        this.send({ method: "subscribeTokenTrade", keys: missing });
      }
      return true;
    }
    if (record.type === "error") {
      const message = typeof record.message === "string" ? record.message.slice(0, 240) : "";
      this.log.info("ws control", {
        code: typeof record.code === "string" ? record.code : "error",
        message,
      });
      if (!this.retried) {
        this.retried = true;
        this.flushPending();
      }
      return true;
    }
    return true;
  }

  /** PumpPortal speaks `{ message }` instead of `{ type }`. The body is not a trade. */
  private onPortalNotice(raw: unknown): boolean {
    if (!this.portal || !raw || typeof raw !== "object") return false;
    const record = raw as Record<string, unknown>;
    if (typeof record.txType === "string" || typeof record.mint === "string") return false;
    if (typeof record.message !== "string") return false;
    const text = record.message.slice(0, 180);
    if (/api key/i.test(text)) {
      if (this.portalKeyWarned) return true;
      this.portalKeyWarned = true;
      this.log.error("pumpportal trades require a key", {
        warning:
          "Trade subscriptions were rejected. Set PUMPPORTAL_API_KEY. The linked wallet must hold at least 0.02 SOL. New-token events still arrive.",
      });
      return true;
    }
    this.log.info("pumpportal", { message: text });
    return true;
  }

  private onAuth(record: Record<string, unknown>): void {
    const status = typeof record.status === "string" ? record.status : "unknown";
    const tier = typeof record.tier === "string" && record.tier.trim() !== "" ? record.tier.trim().toLowerCase() : "anonymous";
    const reported = typeof record.limit === "number" && Number.isFinite(record.limit) && record.limit > 0
      ? Math.floor(record.limit)
      : TIER_SUBSCRIPTION_LIMIT[tier];
    if (reported != null) {
      const capped = this.configuredMax != null ? Math.min(this.configuredMax, reported) : reported;
      this.subscriptionLimit = Math.max(1, capped);
    }
    this.log.info("ws auth", { status, tier, limit: this.subscriptionLimit });
    if (tier === "anonymous") {
      this.log.error("ws auth anonymous", {
        warning: "PumpDev tier is still anonymous; live trade subscriptions stay capped",
        status,
        tier,
        limit: this.subscriptionLimit,
      });
    }
    this.enforceCap();
  }

  private enforceCap(): void {
    const overflow = [...this.wanted].slice(this.subscriptionLimit);
    for (const mint of overflow) {
      this.wanted.delete(mint);
      this.acked.delete(mint);
      this.queued.add(mint);
    }
    if (overflow.length > 0) this.send({ method: "unsubscribeTokenTrade", keys: overflow });
    this.promote();
  }

  private promote(): void {
    let added = false;
    for (const mint of [...this.queued]) {
      if (this.wanted.size >= this.subscriptionLimit) break;
      this.queued.delete(mint);
      this.wanted.add(mint);
      added = true;
    }
    if (added) this.flushPending();
  }

  private flushPending(): void {
    const pending = this.portal
      ? [...this.wanted].filter((mint) => !this.sent.has(mint))
      : [...this.wanted].filter((mint) => !this.acked.has(mint));
    if (pending.length === 0) return;
    const batch = this.portal ? PORTAL_SUBSCRIBE_BATCH : pending.length;
    for (let index = 0; index < pending.length; index += batch) {
      const keys = pending.slice(index, index + batch);
      const payload: { method: string; keys: string[]; apiKey?: string } = {
        method: "subscribeTokenTrade",
        keys,
      };
      if (this.portalKey) payload.apiKey = this.portalKey;
      this.send(payload);
      if (this.portal) for (const mint of keys) this.sent.add(mint);
    }
  }

  private send(payload: unknown): void {
    if (!this.opened) return;
    try {
      this.ws?.send(JSON.stringify(payload));
    } catch (error) {
      this.log.info("ws send failed", { error: error instanceof Error ? error.message : "ws-send" });
    }
  }
}
