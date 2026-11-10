/**
 * Shared token bucket for Helius. Every JSON-RPC call this process makes
 * takes one token. A short cache absorbs duplicate reads, and HTTP 429 / 5xx
 * retry with exponential backoff plus jitter.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly rps: number,
    opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    if (!(rps > 0) || !Number.isFinite(rps)) throw new Error("rps must be positive");
    this.tokens = rps;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.updatedAt = this.now();
  }

  acquire(): Promise<void> {
    const run = this.chain.then(() => this.take());
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.rps) * 1000));
      await this.sleep(waitMs);
    }
  }

  private refill(): void {
    const at = this.now();
    const elapsed = Math.max(0, at - this.updatedAt);
    this.updatedAt = at;
    this.tokens = Math.min(this.rps, this.tokens + (elapsed / 1000) * this.rps);
  }
}

/** Reads we are willing to replay from a short cache. Writes and simulations are not cached. */
const CACHEABLE = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenLargestAccounts",
  "getTokenSupply",
  "getTransaction",
  "getSignaturesForAddress",
  "getPriorityFeeEstimate",
  "getRecentPrioritizationFees",
]);

export interface RpcStats {
  http429: number;
  retries: number;
}

export function createRpcStats(): RpcStats {
  return { http429: 0, retries: 0 };
}

export interface RpcFetchOptions {
  rps: number;
  cacheTtlMs: number;
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  fetchImpl?: typeof fetch;
  bucket?: TokenBucket;
  stats?: RpcStats;
}

/** Log the 429 and retry totals once per interval, and only when they moved. */
export function startRpcPressureLog(
  log: { info(message: string, fields?: Record<string, unknown>): void },
  stats: RpcStats,
  intervalMs = 30_000,
): () => void {
  let last429 = stats.http429;
  let lastRetry = stats.retries;
  const flush = () => {
    const http429 = stats.http429 - last429;
    const retries = stats.retries - lastRetry;
    last429 = stats.http429;
    lastRetry = stats.retries;
    if (http429 === 0 && retries === 0) return;
    log.info("rpc pressure", { http429, retries, http429Total: stats.http429, retriesTotal: stats.retries });
  };
  const timer = setInterval(flush, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    flush();
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function rpcBodyHasError(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | Array<{ error?: unknown }>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.some((row) => row !== null && typeof row === "object" && "error" in row && row.error != null);
  } catch {
    return false;
  }
}

function isCacheableBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { method?: unknown } | Array<{ method?: unknown }>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.length > 0 && rows.every((row) => typeof row.method === "string" && CACHEABLE.has(row.method));
  } catch {
    return false;
  }
}

/**
 * Drop-in `fetch` that rate-limits, retries 429 and 5xx, and caches successful
 * read calls for `cacheTtlMs`. Cache hits do not spend a token.
 */
export function createRpcFetch(options: RpcFetchOptions): typeof fetch {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const fetchImpl = options.fetchImpl ?? fetch;
  const bucket = options.bucket ?? new TokenBucket(options.rps, { now, sleep });
  const maxAttempts = options.maxAttempts ?? 4;
  const cache = new Map<string, { at: number; status: number; body: string }>();

  const wrapped: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : null;
    const cacheable = body !== null && options.cacheTtlMs > 0 && isCacheableBody(body);
    const key = `${requestUrl(input)}\n${body ?? ""}`;
    if (cacheable) {
      const hit = cache.get(key);
      if (hit && now() - hit.at < options.cacheTtlMs) {
        return new Response(hit.body, {
          status: hit.status,
          headers: { "content-type": "application/json" },
        });
      }
    }

    let last: Response | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await bucket.acquire();
      const response = await fetchImpl(input, init);
      const retry = response.status === 429 || response.status >= 500;
      if (response.status === 429) options.stats && (options.stats.http429 += 1);
      if (!retry) {
        if (cacheable && response.ok) {
          const text = await response.text();
          // Helius answers "not a Token mint" with HTTP 200. Caching that hides the mint
          // for the whole TTL, which is longer than the buy budget.
          if (!rpcBodyHasError(text)) {
            cache.set(key, { at: now(), status: response.status, body: text });
          }
          return new Response(text, {
            status: response.status,
            headers: { "content-type": "application/json" },
          });
        }
        return response;
      }
      last = response;
      if (attempt + 1 < maxAttempts) {
        if (options.stats) options.stats.retries += 1;
        const base = 200 * 2 ** attempt;
        const jitter = Math.floor(random() * base * 0.3);
        await sleep(base + jitter);
      }
    }
    return last ?? new Response("", { status: 429 });
  };
  return wrapped;
}
