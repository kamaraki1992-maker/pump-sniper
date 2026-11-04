import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.js";
import type { TradeRecord } from "./types.js";

export interface DailySummary {
  day: string;
  timezone: "Europe/Berlin";
  mode: "paper" | "live" | "mixed" | "none";
  tradesTaken: number;
  wins: number;
  losses: number;
  realizedPnlSol: number;
  realizedPnlUsd: number;
  feesSol: number;
  tipsSol: number;
  failedBuys: number;
  failedSells: number;
  /** Filled sells whose reason is `timeout`. Not also counted as wins or losses. */
  timeouts: number;
  exits: Record<string, number>;
  buySize: { count: number; minSol: number | null; maxSol: number | null; avgSol: number | null };
  /** Curved confidence on filled buys. */
  scores: { count: number; min: number | null; median: number | null; max: number | null; avg: number | null };
}

export function berlinDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function summarizeDay(records: TradeRecord[], day: string): DailySummary {
  const rows = records.filter((record) => berlinDay(record.timestamp) === day);
  const modes = new Set(rows.map((row) => row.mode));
  let mode: DailySummary["mode"] = "none";
  if (modes.size === 1) mode = [...modes][0] ?? "none";
  if (modes.size > 1) mode = "mixed";

  const filledBuys = rows.filter((row) => row.side === "buy" && row.status === "filled");
  const filledSells = rows.filter((row) => row.side === "sell" && row.status === "filled");
  const realized = filledSells.reduce((sum, row) => sum + (row.realizedPnlSol ?? 0), 0);
  const realizedUsd = filledSells.reduce((sum, row) => {
    if (row.realizedPnlSol === null || row.solUsd === null) return sum;
    return sum + row.realizedPnlSol * row.solUsd;
  }, 0);
  const filled = rows.filter((row) => row.status === "filled");
  const priceSells = filledSells.filter((row) => row.reason !== "timeout");
  return {
    day,
    timezone: "Europe/Berlin",
    mode,
    tradesTaken: filledBuys.length,
    wins: priceSells.filter((row) => (row.realizedPnlSol ?? 0) > 0).length,
    losses: priceSells.filter((row) => (row.realizedPnlSol ?? 0) < 0).length,
    realizedPnlSol: round(realized, 9),
    realizedPnlUsd: round(realizedUsd, 4),
    feesSol: round(filled.reduce((sum, row) => sum + row.feesSol, 0), 9),
    tipsSol: round(filled.reduce((sum, row) => sum + row.jitoTipSol, 0), 9),
    failedBuys: rows.filter((row) => row.side === "buy" && row.status === "failed").length,
    failedSells: rows.filter((row) => row.side === "sell" && row.status === "failed").length,
    timeouts: filledSells.filter((row) => row.reason === "timeout").length,
    exits: countReasons(filledSells),
    buySize: sizeDistribution(filledBuys),
    scores: scoreDistribution(filledBuys),
  };
}

export class TradeLog {
  constructor(
    private readonly path: string,
    private readonly secrets: readonly string[] = [],
  ) {}

  append(record: TradeRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const line = redact(JSON.stringify(record), this.secrets);
    appendFileSync(this.path, line + "\n");
  }

  readAll(): TradeRecord[] {
    let raw = "";
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const records: TradeRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as TradeRecord);
      } catch {
        // Skip a torn line rather than failing the report.
      }
    }
    return records;
  }
}

function countReasons(rows: TradeRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  }
  return counts;
}

function sizeDistribution(rows: TradeRecord[]): DailySummary["buySize"] {
  if (rows.length === 0) return { count: 0, minSol: null, maxSol: null, avgSol: null };
  let min = rows[0]?.sizeSol ?? 0;
  let max = min;
  let sum = 0;
  for (const row of rows) {
    min = Math.min(min, row.sizeSol);
    max = Math.max(max, row.sizeSol);
    sum += row.sizeSol;
  }
  return { count: rows.length, minSol: round(min, 9), maxSol: round(max, 9), avgSol: round(sum / rows.length, 9) };
}

function scoreDistribution(rows: TradeRecord[]): DailySummary["scores"] {
  const scores = rows
    .map((row) => row.confidence)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  if (scores.length === 0) return { count: 0, min: null, median: null, max: null, avg: null };
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const sum = sorted.reduce((total, score) => total + score, 0);
  return {
    count: sorted.length,
    min: round(sorted[0]!, 6),
    median: round(median, 6),
    max: round(sorted[sorted.length - 1]!, 6),
    avg: round(sum / sorted.length, 6),
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
