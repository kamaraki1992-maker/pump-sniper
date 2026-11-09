import { PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM_ID } from "./curve-watch.js";
import type { FilterDecision } from "./filter.js";
import { Logger } from "./logger.js";
import { WSOL_MINT } from "./pricing.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** PumpSwap program. The canonical pool is excluded when it already holds the mint. */
export const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

export interface LargestAccount {
  address: string;
  amount: bigint;
}

export interface HolderDecision extends FilterDecision {
  /** Combined top-10 share after exclusions. Null when the check could not run. */
  pct: number | null;
}

function associatedToken(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function canonicalPool(mint: PublicKey): PublicKey {
  const poolAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), mint.toBuffer()],
    PUMP_PROGRAM_ID,
  )[0];
  const index = Buffer.alloc(2);
  index.writeUInt16LE(0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), index, poolAuthority.toBuffer(), mint.toBuffer(), new PublicKey(WSOL_MINT).toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  )[0];
}

/**
 * Addresses that are the curve, its token account, or the PumpSwap pool.
 * `getTokenLargestAccounts` returns token accounts, so both the SPL and
 * Token-2022 ATAs are listed. The curve PDA itself is included because the
 * spec excludes that account even when it is not a token account.
 */
export function excludedHolderAccounts(mint: PublicKey): string[] {
  const curve = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM_ID,
  )[0];
  const pool = canonicalPool(mint);
  const keys = [
    curve,
    associatedToken(curve, mint, TOKEN_PROGRAM_ID),
    associatedToken(curve, mint, TOKEN_2022_PROGRAM_ID),
    pool,
    associatedToken(pool, mint, TOKEN_PROGRAM_ID),
    associatedToken(pool, mint, TOKEN_2022_PROGRAM_ID),
  ];
  return keys.map((key) => key.toBase58());
}

/** Share of `supply` held by the ten largest accounts that are not excluded, in percent. */
export function top10SharePct(accounts: readonly LargestAccount[], supply: bigint, exclude: ReadonlySet<string>): number | null {
  if (supply <= 0n) return null;
  const ranked = accounts
    .filter((row) => row.amount > 0n && !exclude.has(row.address))
    .sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  let sum = 0n;
  for (const row of ranked.slice(0, 10)) sum += row.amount;
  const ppm = (sum * 1_000_000n) / supply;
  return Number(ppm) / 10_000;
}

/** Skip when the filtered top 10 own strictly more than `maxPct` of supply. */
export function top10Decision(
  accounts: readonly LargestAccount[],
  supply: bigint,
  exclude: ReadonlySet<string>,
  maxPct: number,
): HolderDecision {
  const pct = top10SharePct(accounts, supply, exclude);
  if (pct === null || !Number.isFinite(pct)) {
    return { ok: false, reason: "top10-unavailable", pct: null };
  }
  if (pct > maxPct) {
    return {
      ok: false,
      reason: `top10 holders own ${pct.toFixed(2)}% of supply (> ${maxPct}%)`,
      pct,
    };
  }
  return { ok: true, pct };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function readLargestAccounts(result: unknown): LargestAccount[] {
  const record = asRecord(result);
  const value = record && "value" in record ? record.value : result;
  if (!Array.isArray(value)) return [];
  const rows: LargestAccount[] = [];
  for (const item of value) {
    const row = asRecord(item);
    const address = row && typeof row.address === "string" ? row.address : null;
    const amount = row && (typeof row.amount === "string" || typeof row.amount === "number") ? String(row.amount) : null;
    if (!address || amount === null) continue;
    try {
      rows.push({ address, amount: BigInt(amount) });
    } catch {
      // Ignore a malformed balance. The rest of the list can still be scored.
    }
  }
  return rows;
}

export function readSupplyAmount(result: unknown): bigint | null {
  const record = asRecord(result);
  const value = record && "value" in record ? asRecord(record.value) : record;
  const amount = value && (typeof value.amount === "string" || typeof value.amount === "number") ? String(value.amount) : null;
  if (amount === null) return null;
  try {
    return BigInt(amount);
  } catch {
    return null;
  }
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { message?: string };
}

/** On-chain top-10 check. Failures skip the buy; they do not open it. */
export class RpcHolderCheck {
  constructor(
    private readonly rpcUrl: string,
    private readonly maxPct: number,
    private readonly rpcFetch: typeof fetch,
    private readonly log: Logger,
  ) {}

  async lookup(mint: string): Promise<HolderDecision> {
    try {
      const mintKey = new PublicKey(mint);
      const exclude = new Set(excludedHolderAccounts(mintKey));
      const largest = await this.rpc<unknown>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
      const supplyBody = await this.rpc<unknown>("getTokenSupply", [mint, { commitment: "confirmed" }]);
      const supply = readSupplyAmount(supplyBody);
      if (supply === null) return { ok: false, reason: "top10-unavailable", pct: null };
      return top10Decision(readLargestAccounts(largest), supply, exclude, this.maxPct);
    } catch (error) {
      this.log.info("top10 check failed", {
        mint,
        error: error instanceof Error ? error.message : "rpc-error",
      });
      return { ok: false, reason: "top10-unavailable", pct: null };
    }
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await this.rpcFetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`rpc HTTP ${response.status}`);
    const payload = (await response.json()) as RpcEnvelope<T>;
    if (payload.error) throw new Error(payload.error.message ?? "rpc error");
    if (payload.result === undefined) throw new Error("rpc result missing");
    return payload.result;
  }
}
