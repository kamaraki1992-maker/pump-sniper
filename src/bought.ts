import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Mints this process has already reserved a buy for. Keyed by mint, not name or symbol. */
export class BoughtMints {
  private readonly mints: Set<string>;

  constructor(private readonly path: string) {
    this.mints = new Set(readMints(path));
  }

  has(mint: string): boolean {
    return this.mints.has(mint);
  }

  list(): string[] {
    return [...this.mints];
  }

  /** Persist before the buy is awaited, so a restart cannot take the same mint. */
  add(mint: string): void {
    if (!mint || this.mints.has(mint)) return;
    this.mints.add(mint);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.mints]));
    renameSync(tmp, this.path);
  }
}

function readMints(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((mint): mint is string => typeof mint === "string" && mint.length > 0);
  } catch {
    return [];
  }
}
