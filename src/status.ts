import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { drawdownPct, positionValueSol, type EquityFile, type KillFile } from "./momentum/equity.js";
import type { TradeRecord } from "./types.js";

export interface StatusReport {
  totalTrades: number;
  winRate: number | null;
  grossPnlSol: number;
  netPnlSol: number;
  grossPnlUsd: number | null;
  netPnlUsd: number | null;
  solUsd: number | null;
  fees: {
    baseFeeSol: number;
    priorityFeeSol: number;
    tipSol: number;
    swapFeeSol: number;
    closeFeeSol: number;
    rentDebitSol: number;
    rentCreditSol: number;
  };
  openPositions: Array<{
    mint: string;
    symbol: string;
    tokenAmount: number;
    uPnlSol: number;
    uPnlUsd: number | null;
  }>;
  equitySol: number | null;
  highWaterMarkSol: number | null;
  drawdownPct: number | null;
  killSwitch: { active: boolean; reason: string | null };
  sessionStart: string | null;
  solCrashPause: { active: boolean; until: string | null; high: number | null; price: number | null };
  entryTypes: {
    breakout: EntryTypeStats;
    pullback: EntryTypeStats;
  };
}

export interface EntryTypeStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readTrades(path: string): TradeRecord[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TradeRecord);
  } catch {
    return [];
  }
}

/** One JSON status snapshot from the data files. It does not start the bot. */
export function buildStatus(input: {
  tradesPath: string;
  positionsPath: string;
  equityPath: string;
  killPath: string;
  paperBalancePath: string;
  gasReserveUsd: number;
  feeBps: number;
  solCrashPath?: string;
  nowMs?: number;
}): StatusReport {
  const trades = readTrades(input.tradesPath);
  const filled = trades.filter((row) => row.status === "filled");
  const sells = filled.filter((row) => row.side === "sell" && typeof row.realizedPnlSol === "number");
  const wins = sells.filter((row) => (row.realizedPnlSol ?? 0) > 0).length;
  const losses = sells.filter((row) => (row.realizedPnlSol ?? 0) < 0).length;
  const entryTypes = {
    breakout: emptyEntryStats(),
    pullback: emptyEntryStats(),
  };
  for (const sell of sells) {
    const kind = sellEntryType(sell, filled);
    if (!kind) continue;
    const bucket = entryTypes[kind];
    bucket.trades += 1;
    if ((sell.realizedPnlSol ?? 0) > 0) bucket.wins += 1;
    if ((sell.realizedPnlSol ?? 0) < 0) bucket.losses += 1;
  }
  for (const bucket of Object.values(entryTypes)) {
    bucket.winRate = bucket.wins + bucket.losses > 0 ? bucket.wins / (bucket.wins + bucket.losses) : null;
  }
  const netPnlSol = sells.reduce((sum, row) => sum + (row.realizedPnlSol ?? 0), 0);
  const fees = {
    baseFeeSol: 0,
    priorityFeeSol: 0,
    tipSol: 0,
    swapFeeSol: 0,
    closeFeeSol: 0,
    rentDebitSol: 0,
    rentCreditSol: 0,
  };
  let feeSol = 0;
  for (const row of filled) {
    fees.tipSol += row.costs?.tipSol ?? row.jitoTipSol ?? 0;
    if (row.costs) {
      fees.baseFeeSol += row.costs.baseFeeSol;
      fees.priorityFeeSol += row.costs.priorityFeeSol;
      fees.swapFeeSol += row.costs.swapFeeSol;
      fees.closeFeeSol += row.costs.closeFeeSol;
      if (row.costs.ataRentSol < 0) fees.rentDebitSol += -row.costs.ataRentSol;
      if (row.costs.ataRentSol > 0) fees.rentCreditSol += row.costs.ataRentSol;
      feeSol +=
        row.costs.baseFeeSol +
        row.costs.priorityFeeSol +
        row.costs.tipSol +
        row.costs.swapFeeSol +
        row.costs.closeFeeSol;
    } else {
      feeSol += row.feesSol + row.jitoTipSol;
    }
  }
  const solUsd = [...filled].reverse().find((row) => row.solUsd != null && row.solUsd > 0)?.solUsd ?? null;
  const snapshot = readJson<{ solUsd?: number | null; positions?: Array<Record<string, unknown>> }>(input.positionsPath);
  const markUsd = solUsd ?? (typeof snapshot?.solUsd === "number" ? snapshot.solUsd : null);
  const positions = snapshot?.positions ?? [];
  let mtm = 0;
  const openPositions = positions.map((row) => {
    const tokenAmount = typeof row.tokenAmount === "number" ? row.tokenAmount : 0;
    const mark = typeof row.lastMarkPriceSol === "number" ? row.lastMarkPriceSol : 0;
    const cost = typeof row.costSol === "number" ? row.costSol : 0;
    const value = positionValueSol(tokenAmount, mark, input.feeBps, 0.000005, 0.00005);
    mtm += value;
    const uPnlSol = value - cost;
    return {
      mint: String(row.mint ?? ""),
      symbol: String(row.symbol ?? ""),
      tokenAmount,
      uPnlSol,
      uPnlUsd: markUsd != null ? uPnlSol * markUsd : null,
    };
  });
  const paper = readJson<{ cashSol?: number }>(input.paperBalancePath);
  const cash = typeof paper?.cashSol === "number" ? paper.cashSol : null;
  const reserveSol = markUsd != null && markUsd > 0 ? input.gasReserveUsd / markUsd : 0;
  const equitySol = cash == null ? null : cash + reserveSol + mtm;
  const equity = readJson<EquityFile>(input.equityPath);
  const kill = existsSync(input.killPath);
  const killBody = kill ? readJson<KillFile>(input.killPath) : null;
  const grossPnlSol = netPnlSol + feeSol;
  const crash = input.solCrashPath
    ? readJson<{ pauseUntilMs?: number; high?: number | null; price?: number | null }>(input.solCrashPath)
    : null;
  const nowMs = input.nowMs ?? Date.now();
  const pauseUntil = typeof crash?.pauseUntilMs === "number" ? crash.pauseUntilMs : 0;
  return {
    totalTrades: filled.length,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    grossPnlSol,
    netPnlSol,
    grossPnlUsd: markUsd != null ? grossPnlSol * markUsd : null,
    netPnlUsd: markUsd != null ? netPnlSol * markUsd : null,
    solUsd: markUsd,
    fees,
    openPositions,
    equitySol,
    highWaterMarkSol: equity?.hwmSol ?? null,
    drawdownPct: equitySol != null && equity ? drawdownPct(equitySol, equity.hwmSol) : null,
    killSwitch: { active: kill, reason: killBody?.reason ?? null },
    sessionStart: equity?.sessionStart ?? null,
    entryTypes,
    solCrashPause: {
      active: pauseUntil > nowMs,
      until: pauseUntil > 0 ? new Date(pauseUntil).toISOString() : null,
      high: typeof crash?.high === "number" ? crash.high : null,
      price: typeof crash?.price === "number" ? crash.price : null,
    },
  };
}

function emptyEntryStats(): EntryTypeStats {
  return { trades: 0, wins: 0, losses: 0, winRate: null };
}

function sellEntryType(sell: TradeRecord, trades: TradeRecord[]): "breakout" | "pullback" | null {
  if (sell.entryType === "breakout" || sell.entryType === "pullback") return sell.entryType;
  let found: "breakout" | "pullback" | null = null;
  for (const row of trades) {
    if (row.side !== "buy" || row.mint !== sell.mint || row.timestamp > sell.timestamp) continue;
    if (row.entryType === "breakout" || row.entryType === "pullback") found = row.entryType;
  }
  return found;
}

function round(value: number | null, digits: number): number | null {
  if (value == null || !Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

if (process.argv[1]?.endsWith("status.ts")) {
  const config = loadConfig();
  const report = buildStatus({
    tradesPath: config.tradesPath,
    positionsPath: config.positionsPath,
    equityPath: `${config.dataDir}/equity-hwm.json`,
    killPath: config.killFile,
    paperBalancePath: `${config.dataDir}/paper-balance.json`,
    gasReserveUsd: config.gasReserveUsd,
    feeBps: config.momentumPumpswapFeeBps,
    solCrashPath: `${config.dataDir}/sol-crash.json`,
  });
  report.grossPnlSol = round(report.grossPnlSol, 9) ?? 0;
  report.netPnlSol = round(report.netPnlSol, 9) ?? 0;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
