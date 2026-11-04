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
  return {
    day,
    timezone: "Europe/Berlin",
    mode,
    tradesTaken: filledBuys.length,
    wins: filledSells.filter((row) => (row.realizedPnlSol ?? 0) > 0).length,
    losses: filledSells.filter((row) => (row.realizedPnlSol ?? 0) < 0).length,
    realizedPnlSol: round(realized, 9),
    realizedPnlUsd: round(realizedUsd, 4),
    feesSol: round(filled.reduce((sum, row) => sum + row.feesSol, 0), 9),
    tipsSol: round(filled.reduce((sum, row) => sum + row.jitoTipSol, 0), 9),
    failedBuys: rows.filter((row) => row.side === "buy" && row.status === "failed").length,
    failedSells: rows.filter((row) => row.side === "sell" && row.status === "failed").length,
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

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
