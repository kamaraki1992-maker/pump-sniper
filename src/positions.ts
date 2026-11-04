import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PaperModel } from "./config.js";
import { unrealizedPnlSol } from "./paper-math.js";
import type { Position } from "./types.js";

export interface PositionView extends Position {
  unrealizedPnlSol: number;
  unrealizedPnlUsd: number | null;
}

export interface PositionSnapshot {
  updatedAt: string;
  solUsd: number | null;
  positions: PositionView[];
}

export function buildSnapshot(
  positions: Position[],
  solUsd: number | null,
  model: PaperModel,
  nowIso: string,
): PositionSnapshot {
  return {
    updatedAt: nowIso,
    solUsd,
    positions: positions.map((position) => {
      const pnl = unrealizedPnlSol(position.tokenAmount, position.costSol, position.lastMarkPriceSol, model);
      return {
        ...position,
        unrealizedPnlSol: round(pnl, 9),
        unrealizedPnlUsd: solUsd === null ? null : round(pnl * solUsd, 4),
      };
    }),
  };
}

export class PositionBook {
  private readonly positions = new Map<string, Position>();

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as { positions?: Position[] };
      for (const position of parsed.positions ?? []) {
        if (position?.mint) this.positions.set(position.mint, position);
      }
    } catch {
      // Missing or unreadable state starts empty.
    }
  }

  list(): Position[] {
    return [...this.positions.values()];
  }

  get(mint: string): Position | undefined {
    return this.positions.get(mint);
  }

  open(position: Position): void {
    this.positions.set(position.mint, position);
  }

  close(mint: string): void {
    this.positions.delete(mint);
  }

  save(solUsd: number | null, model: PaperModel, nowIso: string): void {
    const snapshot = buildSnapshot(this.list(), solUsd, model, nowIso);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    renameSync(tmp, this.path);
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
