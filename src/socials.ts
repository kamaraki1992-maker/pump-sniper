export interface SocialHit {
  twitter: string | null;
  telegram: string | null;
}

export interface SocialDecision extends SocialHit {
  ok: boolean;
  reason: "no_socials" | "metadata_unavailable" | null;
  /** Fetch attempts used for this result. A cache hit repeats the stored count. */
  attempts?: number;
  /** Milliseconds from the first attempt to this result. */
  latencyMs?: number;
  /** Host that returned JSON. Null when every attempt failed. */
  gateway?: string | null;
}

const IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://pump.mypinata.cloud/ipfs/"];

/** Pump.fun does not verify these. A hit only means the field is present and shaped like a link. */
export function plausibleTwitter(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 200) return false;
  if (/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?$/i.test(text)) return true;
  return /^@?[A-Za-z0-9_]{1,15}$/.test(text);
}

export function plausibleTelegram(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 200) return false;
  return /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/[A-Za-z0-9_]{3,}\/?$/i.test(text);
}

function readField(record: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Pull twitter/X and telegram. `website` is ignored, including when it points at X. */
export function socialsFromMetadata(body: unknown): SocialHit {
  if (!body || typeof body !== "object") return { twitter: null, telegram: null };
  const record = body as Record<string, unknown>;
  const extensions = record.extensions && typeof record.extensions === "object" ? (record.extensions as Record<string, unknown>) : {};
  const twitterRaw = readField(record, ["twitter", "x", "twitter_url"]) ?? readField(extensions, ["twitter", "x", "twitter_url"]);
  const telegramRaw = readField(record, ["telegram", "telegram_url"]) ?? readField(extensions, ["telegram", "telegram_url"]);
  return {
    twitter: twitterRaw && plausibleTwitter(twitterRaw) ? twitterRaw : null,
    telegram: telegramRaw && plausibleTelegram(telegramRaw) ? telegramRaw : null,
  };
}

export function socialDecision(hit: SocialHit, mode: "any" | "both"): SocialDecision {
  const ok = mode === "both" ? Boolean(hit.twitter && hit.telegram) : Boolean(hit.twitter || hit.telegram);
  return { ...hit, ok, reason: ok ? null : "no_socials" };
}

/** Original URL first, then public IPFS gateways when the URI is ipfs. */
export function metadataUrls(uri: string): string[] {
  const trimmed = uri.trim();
  const urls: string[] = [];
  const push = (url: string) => {
    if (url && !urls.includes(url)) urls.push(url);
  };
  push(trimmed);
  let path = "";
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(trimmed);
  if (ipfs?.[1]) path = ipfs[1];
  const gateway = /\/ipfs\/([^?#]+)/i.exec(trimmed);
  if (!path && gateway?.[1]) path = gateway[1];
  if (path) {
    for (const host of IPFS_GATEWAYS) push(`${host}${path.replace(/^\/+/, "")}`);
  }
  return urls;
}

export interface MetadataLookupLimits {
  /** Stop starting new attempts at this clock time. The first attempt still runs. */
  deadlineAtMs?: number;
}

export interface MetadataSocialOptions {
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout. `timeoutMs` is the same knob, kept for existing callers. */
  attemptTimeoutMs?: number;
  timeoutMs?: number;
  /** When false, a failed attempt is not retried. Default true. */
  retry?: boolean;
  /** Fixed backoff. Unset picks 300–500ms. */
  backoffMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  mode?: "any" | "both";
}

const MAX_ATTEMPTS = 24;

function gatewayHost(url: string): string {
  try {
    const host = new URL(url).host;
    return host || url;
  } catch {
    return url;
  }
}

/**
 * Fetch token metadata. Each attempt hits one gateway and gives up after
 * `attemptTimeoutMs`. Failures rotate gateways until the deadline. A JSON
 * body is final: valid links succeed, and a body with no valid links is
 * `no_socials` and is not retried. Timeouts and HTTP errors are not cached.
 */
export class MetadataSocials {
  private readonly cache = new Map<string, { at: number; decision: SocialDecision }>();
  private readonly fetchImpl: typeof fetch;
  private readonly attemptTimeoutMs: number;
  private readonly retry: boolean;
  private readonly backoffMs: number | null;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly mode: "any" | "both";

  constructor(options: MetadataSocialOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? options.timeoutMs ?? 1_200;
    this.retry = options.retry ?? true;
    this.backoffMs = options.backoffMs ?? null;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.mode = options.mode ?? "any";
  }

  async lookup(uri: string, limits?: MetadataLookupLimits): Promise<SocialDecision> {
    const started = this.now();
    const key = uri.trim();
    const unavailable = (attempts: number): SocialDecision => ({
      ok: false,
      reason: "metadata_unavailable",
      twitter: null,
      telegram: null,
      attempts,
      latencyMs: Math.max(0, this.now() - started),
      gateway: null,
    });
    if (!key) return unavailable(0);
    const cached = this.cache.get(key);
    if (cached && started - cached.at < this.cacheTtlMs) return cached.decision;
    const deadlineAt = limits?.deadlineAtMs ?? started;
    const urls = metadataUrls(key);
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
      if (attempts > 0) {
        if (!this.retry || this.now() >= deadlineAt) break;
        const wait = Math.min(this.nextBackoff(), deadlineAt - this.now());
        if (!(wait > 0)) break;
        const before = this.now();
        await this.sleep(wait);
        if (this.now() <= before || this.now() >= deadlineAt) break;
      }
      const remaining = deadlineAt - this.now();
      const timeout = attempts === 0 && remaining <= 0 ? this.attemptTimeoutMs : Math.min(this.attemptTimeoutMs, remaining);
      if (!(timeout > 0)) break;
      const url = urls[attempts % urls.length] ?? key;
      attempts += 1;
      const body = await this.fetchBody(url, timeout);
      if (body === undefined) continue;
      const hit = socialDecision(socialsFromMetadata(body), this.mode);
      const decision: SocialDecision = {
        ...hit,
        attempts,
        latencyMs: Math.max(0, this.now() - started),
        gateway: gatewayHost(url),
      };
      this.cache.set(key, { at: this.now(), decision });
      return decision;
    }
    return unavailable(attempts);
  }

  private nextBackoff(): number {
    if (this.backoffMs != null) return this.backoffMs;
    return 300 + Math.floor(Math.random() * 201);
  }

  /** JSON body, or undefined when this gateway did not answer. */
  private async fetchBody(url: string, timeoutMs: number): Promise<unknown | undefined> {
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return undefined;
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  }
}
