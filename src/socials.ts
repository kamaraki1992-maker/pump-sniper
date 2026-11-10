export interface SocialHit {
  twitter: string | null;
  telegram: string | null;
}

export interface SocialDecision extends SocialHit {
  ok: boolean;
  reason: "no_socials" | "metadata_unavailable" | null;
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

export interface MetadataSocialOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
  mode?: "any" | "both";
}

const UNAVAILABLE: SocialDecision = { ok: false, reason: "metadata_unavailable", twitter: null, telegram: null };

/** Fetch token metadata. The whole attempt, including gateway fallbacks, stops at `timeoutMs`. */
export class MetadataSocials {
  private readonly cache = new Map<string, { at: number; decision: SocialDecision }>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly mode: "any" | "both";

  constructor(options: MetadataSocialOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 2_500;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.mode = options.mode ?? "any";
  }

  async lookup(uri: string): Promise<SocialDecision> {
    const key = uri.trim();
    if (!key) return UNAVAILABLE;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.cacheTtlMs) return cached.decision;
    const decision = await this.fetchAll(key);
    this.cache.set(key, { at: this.now(), decision });
    return decision;
  }

  private async fetchAll(uri: string): Promise<SocialDecision> {
    const deadline = this.now() + this.timeoutMs;
    for (const url of metadataUrls(uri)) {
      const left = deadline - this.now();
      if (left <= 0) return UNAVAILABLE;
      try {
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(left) });
        if (!response.ok) continue;
        const body = (await response.json()) as unknown;
        return socialDecision(socialsFromMetadata(body), this.mode);
      } catch {
        continue;
      }
    }
    return UNAVAILABLE;
  }
}
