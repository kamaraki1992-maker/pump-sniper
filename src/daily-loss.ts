import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Mode } from "./types.js";

export interface DayPnl {
  day: string;
  realizedSol: number;
}

type LedgerFile = Partial<Record<Mode, DayPnl>>;

/**
 * Realized net PnL for the Europe/Berlin day, stored per mode.
 * A restart reads the same file. A new Berlin day starts at zero.
 * Unrealized marks are not included.
 */
export class DailyLossBook {
  constructor(private readonly path: string) {}

  realized(mode: Mode, day: string): number {
    const row = this.read()[mode];
    if (!row || row.day !== day || !Number.isFinite(row.realizedSol)) return 0;
    return row.realizedSol;
  }

  add(mode: Mode, day: string, delta: number): number {
    const all = this.read();
    const row = all[mode];
    const base = row && row.day === day && Number.isFinite(row.realizedSol) ? row.realizedSol : 0;
    const realizedSol = base + delta;
    all[mode] = { day, realizedSol };
    this.write(all);
    return realizedSol;
  }

  private read(): LedgerFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as LedgerFile;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private write(value: LedgerFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, this.path);
  }
}
