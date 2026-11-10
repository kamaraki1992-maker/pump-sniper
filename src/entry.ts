export interface EntryPrint {
  atMs: number;
  side: "buy" | "sell";
  trader: string;
  sol: number;
}

export interface EntrySample {
  startedAtMs: number;
  nowMs: number;
  startPrice: number;
  price: number;
  creator: string;
  /** Wallets that bought in the create transaction or the create slot. */
  bundled: ReadonlySet<string>;
  prints: readonly EntryPrint[];
  minBuys: number;
  minUniqueBuyers: number;
  minNetBuySol: number;
  minBuyRatio: number;
  maxRunupPct: number;
  /** Bucket width. When omitted, each of the three buckets is one third of the watch so far. */
  bucketMs?: number;
}

export type EntryVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "entry_low_buyers"
        | "entry_low_volume"
        | "entry_burst"
        | "entry_runup"
        | "entry_creator_sold"
        | "entry_timeout";
    };

function organic(sample: EntrySample, print: EntryPrint): boolean {
  if (!print.trader || print.trader === sample.creator) return false;
  if (sample.bundled.has(print.trader)) return false;
  return true;
}

/** Width of one entry bucket. The default is one third of the time since the watch started. */
export function entryBucketMs(startedAtMs: number, nowMs: number, overrideMs?: number): number {
  if (overrideMs != null && overrideMs > 0) return overrideMs;
  const elapsed = nowMs - startedAtMs;
  if (!(elapsed > 0)) return 0;
  return elapsed / 3;
}

/**
 * Buys in how many of the three buckets that tile the watch.
 * A 5s window uses ~1.67s buckets, so two separate bursts inside those 5s can pass.
 */
export function recentBuyBuckets(
  prints: readonly EntryPrint[],
  startedAtMs: number,
  nowMs: number,
  organicPrint: (print: EntryPrint) => boolean,
  bucketMs?: number,
): number {
  const bucket = entryBucketMs(startedAtMs, nowMs, bucketMs);
  if (!(bucket > 0)) return 0;
  let hits = 0;
  for (let i = 0; i < 3; i += 1) {
    const end = nowMs - i * bucket;
    const start = Math.max(startedAtMs, end - bucket);
    const hit = prints.some(
      (print) => print.side === "buy" && organicPrint(print) && print.atMs > start && print.atMs <= end,
    );
    if (hit) hits += 1;
  }
  return hits;
}

/**
 * Confirmation rules for one watch. Caller decides when the window is open.
 * The first failing rule is the skip reason.
 */
export function evaluateEntry(sample: EntrySample): EntryVerdict {
  if (sample.prints.some((print) => print.side === "sell" && print.trader === sample.creator)) {
    return { ok: false, reason: "entry_creator_sold" };
  }
  const kept = sample.prints.filter((print) => organic(sample, print));
  const buys = kept.filter((print) => print.side === "buy");
  const unique = new Set(buys.map((print) => print.trader));
  if (buys.length < sample.minBuys || unique.size < sample.minUniqueBuyers) {
    return { ok: false, reason: "entry_low_buyers" };
  }
  let buySol = 0;
  let sellSol = 0;
  for (const print of kept) {
    if (!(print.sol > 0)) continue;
    if (print.side === "buy") buySol += print.sol;
    else sellSol += print.sol;
  }
  const net = buySol - sellSol;
  const gross = buySol + sellSol;
  const ratio = gross > 0 ? buySol / gross : 0;
  if (net < sample.minNetBuySol || ratio < sample.minBuyRatio) {
    return { ok: false, reason: "entry_low_volume" };
  }
  const buckets = recentBuyBuckets(
    sample.prints,
    sample.startedAtMs,
    sample.nowMs,
    (print) => organic(sample, print),
    sample.bucketMs,
  );
  if (buckets < 2) return { ok: false, reason: "entry_burst" };
  if (!(sample.startPrice > 0) || !(sample.price > sample.startPrice)) {
    return { ok: false, reason: "entry_runup" };
  }
  const runup = ((sample.price / sample.startPrice) - 1) * 100;
  if (runup > sample.maxRunupPct) return { ok: false, reason: "entry_runup" };
  return { ok: true };
}
