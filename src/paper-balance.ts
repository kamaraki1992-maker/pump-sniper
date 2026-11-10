import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Simulated free cash for percent-of-balance sizing.
 * The file is created from the start balance and then updated by fills.
 * Deleting the file is the only reset. Open-position cost is not stored here.
 */
export class PaperBalance {
  constructor(
    private readonly path: string,
    private readonly startSol: number,
  ) {}

  cash(): number {
    const stored = this.read();
    if (stored == null) {
      this.write(this.startSol);
      return this.startSol;
    }
    return stored;
  }

  add(delta: number): number {
    const next = this.cash() + delta;
    this.write(next);
    return next;
  }

  private read(): number | null {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { cashSol?: unknown };
      return typeof parsed.cashSol === "number" && Number.isFinite(parsed.cashSol) ? parsed.cashSol : null;
    } catch {
      return null;
    }
  }

  private write(cashSol: number): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ cashSol }));
    renameSync(tmp, this.path);
  }
}
