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
/** Mayhem program. Its sol vault holds about half of a create_v2 supply. */
export const MAYHEM_PROGRAM_ID = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");

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

function pda(seeds: Buffer[], program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}

export interface ProtocolHolders {
  /** PDAs that own protocol inventory, derived per mint. Not wallet holders. */
  owners: string[];
  /** Those PDAs and their token accounts for this mint. */
  addresses: string[];
  /** Token-2022 ATA of the bonding curve. This is the curve's token account. */
  curveTokenAccount: string;
  /** Token-2022 ATA of the mayhem sol vault. About half of a mayhem launch. */
  mayhemVault: string;
  solVault: string;
}

/**
 * Protocol inventory for one mint. Token accounts are derived with the
 * Token-2022 program id as well as SPL Token, because create_v2 curve and
 * mayhem vaults are Token-2022 ATAs. An SPL-only ATA is a different address
 * and does not hold the supply.
 */
export function protocolHolders(mint: PublicKey): ProtocolHolders {
  const curve = pda([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID);
  const pool = canonicalPool(mint);
  const poolAuthority = pda([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM_ID);
  const solVault = pda([Buffer.from("sol-vault")], MAYHEM_PROGRAM_ID);
  const mayhemState = pda([Buffer.from("mayhem-state"), mint.toBuffer()], MAYHEM_PROGRAM_ID);
  const globalParams = pda([Buffer.from("global-params")], MAYHEM_PROGRAM_ID);
  const global = pda([Buffer.from("global")], PUMP_PROGRAM_ID);
  const mintAuthority = pda([Buffer.from("mint-authority")], PUMP_PROGRAM_ID);
  const eventAuthority = pda([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);
  const owners = [curve, pool, poolAuthority, solVault, mayhemState, globalParams, global, mintAuthority, eventAuthority];
  const keys: PublicKey[] = [...owners];
  for (const owner of owners) {
    keys.push(associatedToken(owner, mint, TOKEN_PROGRAM_ID));
    keys.push(associatedToken(owner, mint, TOKEN_2022_PROGRAM_ID));
  }
  return {
    owners: owners.map((key) => key.toBase58()),
    addresses: [...new Set(keys.map((key) => key.toBase58()))],
    curveTokenAccount: associatedToken(curve, mint, TOKEN_2022_PROGRAM_ID).toBase58(),
    mayhemVault: associatedToken(solVault, mint, TOKEN_2022_PROGRAM_ID).toBase58(),
    solVault: solVault.toBase58(),
  };
}

/**
 * Addresses that are the curve, its token account, the mayhem vault, or the
 * PumpSwap pool. `getTokenLargestAccounts` returns token accounts, so the
 * Token-2022 ATAs are the ones that hold create_v2 supply.
 */
export function excludedHolderAccounts(mint: PublicKey): string[] {
  return protocolHolders(mint).addresses;
}

function isProtocolAccount(
  address: string,
  exclude: ReadonlySet<string>,
  accountOwners?: ReadonlyMap<string, string>,
  protocolOwners?: ReadonlySet<string>,
): boolean {
  if (exclude.has(address)) return true;
  const owner = accountOwners?.get(address);
  return owner !== undefined && protocolOwners !== undefined && protocolOwners.has(owner);
}

/** Share of `supply` held by the ten largest accounts that are not protocol inventory, in percent. */
export function top10SharePct(
  accounts: readonly LargestAccount[],
  supply: bigint,
  exclude: ReadonlySet<string>,
  accountOwners?: ReadonlyMap<string, string>,
  protocolOwners?: ReadonlySet<string>,
): number | null {
  if (supply <= 0n) return null;
  const ranked = accounts
    .filter((row) => row.amount > 0n && !isProtocolAccount(row.address, exclude, accountOwners, protocolOwners))
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
  accountOwners?: ReadonlyMap<string, string>,
  protocolOwners?: ReadonlySet<string>,
): HolderDecision {
  const pct = top10SharePct(accounts, supply, exclude, accountOwners, protocolOwners);
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

const TOKEN_OWNERS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
/** Helius uses this for a mint that is not in the token index yet, including a create_v2 mint. */
const RETRYABLE_MINT = /not a Token mint|could not find mint|could not find account|mint could not be unpacked/i;
const HOLDER_COMMITMENT = "processed";

export interface HolderCheckOptions {
  /** Stop retrying once this many milliseconds have passed. A miss skips the buy. */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Decode a getProgramAccounts row into the token account address and its raw amount. */
export function readProgramAccounts(result: unknown): LargestAccount[] {
  const record = asRecord(result);
  const list = Array.isArray(result) ? result : record && Array.isArray(record.value) ? record.value : [];
  const rows: LargestAccount[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row) continue;
    const address = typeof row.pubkey === "string" ? row.pubkey : typeof row.address === "string" ? row.address : null;
    const account = asRecord(row.account);
    const raw = decodeAccountData(account?.data);
    if (!address || !raw) continue;
    const amountBytes = raw.length === 8 ? raw : raw.length >= 72 ? raw.subarray(64, 72) : null;
    if (!amountBytes || amountBytes.length < 8) continue;
    const view = new DataView(amountBytes.buffer, amountBytes.byteOffset, amountBytes.byteLength);
    rows.push({ address, amount: view.getBigUint64(0, true) });
  }
  return rows;
}

function decodeAccountData(data: unknown): Uint8Array | null {
  if (typeof data === "string" && data.length > 0) return Buffer.from(data, "base64");
  if (Array.isArray(data) && typeof data[0] === "string" && data[0].length > 0) return Buffer.from(data[0], "base64");
  return null;
}

/**
 * On-chain top-10 check. pump.fun create_v2 mints are Token-2022 and are often
 * not visible to getTokenLargestAccounts at `confirmed` on the same tick as the
 * create. The call is retried at `processed` until the budget runs out. A miss
 * still skips the buy.
 */
export class RpcHolderCheck {
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly rpcUrl: string,
    private readonly maxPct: number,
    private readonly rpcFetch: typeof fetch,
    private readonly log: Logger,
    options: HolderCheckOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 1_500;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async lookup(mint: string): Promise<HolderDecision> {
    let mintKey: PublicKey;
    try {
      mintKey = new PublicKey(mint);
    } catch {
      return { ok: false, reason: "top10-unavailable", pct: null };
    }
    const protocol = protocolHolders(mintKey);
    const exclude = new Set(protocol.addresses);
    const protocolOwners = new Set(protocol.owners);
    const deadline = this.now() + this.timeoutMs;
    let attempt = 0;
    let lastError = "top10-unavailable";
    while (this.now() <= deadline && attempt < 6) {
      attempt += 1;
      try {
        const owner = await this.mintOwner(mint);
        if (owner === null) {
          lastError = "top10-mint-not-visible";
        } else if (!TOKEN_OWNERS.has(owner)) {
          this.log.info("top10 check failed", { mint, error: "not a token mint", owner, attempt });
          return { ok: false, reason: "top10-unavailable", pct: null };
        } else {
          const decision = await this.holders(mint, owner, exclude, protocolOwners);
          if (decision) return decision;
          lastError = "top10-holders-not-visible";
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : "rpc-error";
      }
      if (attempt >= 6) break;
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(remaining, 50 * 2 ** Math.min(attempt - 1, 4)));
    }
    this.log.info("top10 check failed", { mint, error: lastError, attempt });
    return { ok: false, reason: "top10-unavailable", pct: null };
  }

  private async holders(
    mint: string,
    owner: string,
    exclude: Set<string>,
    protocolOwners: Set<string>,
  ): Promise<HolderDecision | null> {
    try {
      const fromIndex = await this.scored(
        mint,
        exclude,
        protocolOwners,
        await this.rpc<unknown>("getTokenLargestAccounts", [mint, { commitment: HOLDER_COMMITMENT }]),
      );
      if (fromIndex) return fromIndex;
    } catch (error) {
      const message = error instanceof Error ? error.message : "rpc-error";
      if (!RETRYABLE_MINT.test(message)) throw error;
    }
    // The mint account is already a Token or Token-2022 mint, but the largest-account
    // index still rejects it. Read the token accounts of that program directly.
    return this.scored(
      mint,
      exclude,
      protocolOwners,
      await this.rpc<unknown>("getProgramAccounts", [
        owner,
        {
          commitment: HOLDER_COMMITMENT,
          encoding: "base64",
          dataSlice: { offset: 64, length: 8 },
          filters: [{ memcmp: { offset: 0, bytes: mint } }],
        },
      ]),
      true,
    );
  }

  private async scored(
    mint: string,
    exclude: Set<string>,
    protocolOwners: Set<string>,
    accountsResult: unknown,
    programAccounts = false,
  ): Promise<HolderDecision | null> {
    const rows = programAccounts ? readProgramAccounts(accountsResult) : readLargestAccounts(accountsResult);
    if (rows.length === 0) return null;
    const supply = readSupplyAmount(await this.rpc<unknown>("getTokenSupply", [mint, { commitment: HOLDER_COMMITMENT }]));
    if (supply === null || supply <= 0n) return null;
    const accountOwners = await this.readOwners(rows.map((row) => row.address));
    return top10Decision(rows, supply, exclude, this.maxPct, accountOwners, protocolOwners);
  }

  /** Best-effort. Address derivation still excludes the vaults if this call fails. */
  private async readOwners(addresses: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (addresses.length === 0) return map;
    try {
      const result = await this.rpc<unknown>("getMultipleAccounts", [
        addresses,
        { encoding: "jsonParsed", commitment: HOLDER_COMMITMENT },
      ]);
      const record = asRecord(result);
      const value = record && Array.isArray(record.value) ? record.value : [];
      value.forEach((item, index) => {
        const address = addresses[index];
        const info = asRecord(asRecord(asRecord(asRecord(item)?.data)?.parsed)?.info);
        const owner = info?.owner;
        if (address && typeof owner === "string") map.set(address, owner);
      });
    } catch {
      return map;
    }
    return map;
  }

  private async mintOwner(mint: string): Promise<string | null> {
    const result = await this.rpc<unknown>("getAccountInfo", [
      mint,
      { encoding: "base64", commitment: HOLDER_COMMITMENT },
    ]);
    const record = asRecord(result);
    const value = record && "value" in record ? asRecord(record.value) : null;
    if (!value || typeof value.owner !== "string") return null;
    return value.owner;
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
