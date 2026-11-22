import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Down from the rolling 60-minute high, not from the print of 60 minutes ago. */
export const SOL_CRASH = {
  dropPct: 3,
  pauseMs: 45 * 60 * 1000,
  windowMs: 60 * 60 * 1000,
  sampleMs: 60 * 1000,
  staleMs: 5 * 60 * 1000,
} as const;

export interface SolCrashState {
  kind: "start" | "extend" | "end" | "stale" | null;
  active: boolean;
  pauseUntilMs: number;
  high: number | null;
  price: number | null;
}

interface StoredPause {
  pauseUntilMs: number;
  high: number | null;
  price: number | null;
  updatedAt: string;
}

/**
 * Samples SOL/USD about once a minute. A print more than 3% under the
 * 60-minute high blocks new buys for 45 minutes. A later print that is still
 * that far under the high extends the pause. A feed silent for more than 5
 * minutes is logged and does not start a pause. A pause that already started
 * still runs out its timer.
 */
export class SolCrashGuard {
  private samples: { atMs: number; price: number }[] = [];
  private pauseUntilMs = 0;
  private lastSampleAt = 0;
  private staleLogged = false;
  private wasActive = false;

  constructor(private readonly path?: string) {
    const stored = this.read();
    if (stored && stored.pauseUntilMs > 0) this.pauseUntilMs = stored.pauseUntilMs;
  }

  blocksBuys(nowMs: number): boolean {
    return this.pauseUntilMs > nowMs;
  }

  observe(price: number | null, quotedAtMs: number | null, nowMs: number): SolCrashState {
    const age = quotedAtMs == null ? Number.POSITIVE_INFINITY : nowMs - quotedAtMs;
    const fresh = price != null && price > 0 && age <= SOL_CRASH.staleMs;
    if (!fresh) {
      const active = this.blocksBuys(nowMs);
      let kind: SolCrashState["kind"] = null;
      if (age > SOL_CRASH.staleMs && !this.staleLogged) {
        this.staleLogged = true;
        kind = "stale";
      }
      if (this.wasActive && !active) {
        this.wasActive = false;
        kind = "end";
      }
      this.persist(nowMs, price, null);
      return { kind, active, pauseUntilMs: this.pauseUntilMs, high: null, price };
    }
    this.staleLogged = false;
    let sampled = false;
    if (nowMs - this.lastSampleAt >= SOL_CRASH.sampleMs) {
      this.samples.push({ atMs: nowMs, price });
      this.lastSampleAt = nowMs;
      sampled = true;
    }
    const cutoff = nowMs - SOL_CRASH.windowMs;
    this.samples = this.samples.filter((sample) => sample.atMs >= cutoff);
    const high = this.samples.reduce((max, sample) => Math.max(max, sample.price), 0);
    const drop = high > 0 ? ((high - price) / high) * 100 : 0;
    let kind: SolCrashState["kind"] = null;
    if (sampled && drop > SOL_CRASH.dropPct) {
      const until = nowMs + SOL_CRASH.pauseMs;
      if (!(this.pauseUntilMs > nowMs)) {
        kind = "start";
        this.pauseUntilMs = until;
      } else if (until > this.pauseUntilMs) {
        kind = "extend";
        this.pauseUntilMs = until;
      }
    }
    const active = this.blocksBuys(nowMs);
    if (this.wasActive && !active) kind = "end";
    this.wasActive = active;
    this.persist(nowMs, price, high > 0 ? high : null);
    return { kind, active, pauseUntilMs: this.pauseUntilMs, high: high > 0 ? high : null, price };
  }

  private persist(nowMs: number, price: number | null, high: number | null): void {
    if (!this.path) return;
    const row: StoredPause = {
      pauseUntilMs: this.pauseUntilMs,
      high,
      price,
      updatedAt: new Date(nowMs).toISOString(),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(row));
    renameSync(tmp, this.path);
  }

  private read(): StoredPause | null {
    if (!this.path) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as StoredPause;
      return parsed && typeof parsed.pauseUntilMs === "number" ? parsed : null;
    } catch {
      return null;
    }
  }
}
