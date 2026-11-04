const JUPITER_SOL =
  "https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112";

export class SolPriceFeed {
  private value: number | null = null;

  constructor(
    private readonly url: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  price(): number | null {
    return this.value;
  }

  async refresh(): Promise<number | null> {
    const primary = await this.read(this.url);
    if (primary !== null) {
      this.value = primary;
      return primary;
    }
    const fallback = await this.read(JUPITER_SOL);
    if (fallback !== null) this.value = fallback;
    return this.value;
  }

  private async read(url: string): Promise<number | null> {
    try {
      const response = await this.fetcher(url, { headers: { accept: "application/json" } });
      if (!response.ok) return null;
      const body = (await response.json()) as unknown;
      return parseSolUsd(body);
    } catch {
      return null;
    }
  }
}

export function parseSolUsd(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const gecko = record.solana;
  if (gecko && typeof gecko === "object") {
    const usd = (gecko as { usd?: unknown }).usd;
    if (typeof usd === "number" && usd > 0) return usd;
  }
  const wrapped = record.So11111111111111111111111111111111111111112;
  if (wrapped && typeof wrapped === "object") {
    const usd = (wrapped as { usdPrice?: unknown }).usdPrice;
    if (typeof usd === "number" && usd > 0) return usd;
  }
  return null;
}
