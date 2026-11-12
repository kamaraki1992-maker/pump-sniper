import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MOMENTUM } from "./rules.js";

export interface EquityFile {
  hwmSol: number;
  sessionStart: string;
  updatedAt: string;
}

export interface KillFile {
  reason: string;
  equitySol: number;
  hwmSol: number;
  at: string;
}

/** Mark to market after the swap fee and one signature's base and priority fee. */
export function positionValueSol(
  tokenAmount: number,
  markPriceSol: number,
  feeBps: number,
  baseFeeSol: number,
  priorityFeeSol: number,
): number {
  if (!(tokenAmount > 0) || !(markPriceSol > 0)) return 0;
  const gross = tokenAmount * markPriceSol;
  const net = gross * (1 - Math.max(0, feeBps) / 10_000) - baseFeeSol - priorityFeeSol;
  return Math.max(0, net);
}

export function drawdownPct(equitySol: number, hwmSol: number): number | null {
  if (!(hwmSol > 0) || !Number.isFinite(equitySol)) return null;
  return ((hwmSol - equitySol) / hwmSol) * 100;
}

export function killTriggered(equitySol: number, hwmSol: number): boolean {
  if (!(hwmSol > 0) || !Number.isFinite(equitySol)) return false;
  return (hwmSol - equitySol) / hwmSol + 1e-9 >= MOMENTUM.killDrawdown;
}

/**
 * High-water mark of total equity. A 25% drop writes the kill file and
 * blocks new entries until that file is removed by hand.
 */
export class EquityBook {
  constructor(
    private readonly path: string,
    private readonly killPath: string,
  ) {}

  read(): EquityFile | null {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as EquityFile;
      if (!parsed || !(parsed.hwmSol > 0) || typeof parsed.sessionStart !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  killed(): boolean {
    return existsSync(this.killPath);
  }

  killReason(): KillFile | null {
    try {
      const parsed = JSON.parse(readFileSync(this.killPath, "utf8")) as KillFile;
      return parsed && typeof parsed.reason === "string" ? parsed : null;
    } catch {
      return this.killed() ? { reason: "drawdown", equitySol: 0, hwmSol: 0, at: "" } : null;
    }
  }

  /**
   * Raises the high-water mark. A 25% drop writes KILL and leaves the mark
   * where it is. An existing KILL file is not cleared here.
   */
  mark(equitySol: number, nowIso: string): { hwmSol: number; killed: boolean; sessionStart: string } {
    const prior = this.read();
    const sessionStart = prior?.sessionStart ?? nowIso;
    let hwmSol = prior?.hwmSol ?? equitySol;
    if (!this.killed() && equitySol > hwmSol) hwmSol = equitySol;
    const row: EquityFile = { hwmSol, sessionStart, updatedAt: nowIso };
    this.write(row);
    if (!this.killed() && killTriggered(equitySol, hwmSol)) {
      this.writeKill({
        reason: "equity fell 25% from the high-water mark",
        equitySol,
        hwmSol,
        at: nowIso,
      });
    }
    return { hwmSol, killed: this.killed(), sessionStart };
  }

  private write(row: EquityFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(row));
    renameSync(tmp, this.path);
  }

  private writeKill(row: KillFile): void {
    mkdirSync(dirname(this.killPath), { recursive: true });
    writeFileSync(this.killPath, `${JSON.stringify(row)}\n`);
  }
}
