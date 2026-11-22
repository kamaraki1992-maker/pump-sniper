import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { parseBundleTransaction } from "../bundle-api.js";
import type { AppConfig } from "../config.js";
import { protocolHolders } from "../holders.js";

/**
 * Same public payer the sniper sim uses. sigVerify is off, so the simulation
 * does not spend its funds. A sell still fails when that account holds none
 * of the mint; that missing balance is not a honeypot.
 */
const SIM_PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

export type SellSim = "ok" | "fail" | "transfer-fee" | "no-balance" | "unsimulated";

/**
 * Sellable only when the round trip actually sold. A missing ATA is not itself
 * a honeypot, but it is not a pass either: the sell did not run. Any other
 * program error is a skip named with its code.
 */
export function honeypotDecision(result: SellSim, code?: number | null): { ok: boolean; reason: string | null } {
  if (result === "ok") return { ok: true, reason: null };
  if (result === "unsimulated") return { ok: false, reason: "honeypot_unsimulated" };
  if (result === "transfer-fee") return { ok: false, reason: "transfer-fee" };
  const suffix = code != null ? `:${code}` : "";
  return { ok: false, reason: `honeypot_sim_error${suffix}` };
}

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMP_CURVE = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/** pump-amm global config. `buyback_fee_recipients` is eight pubkeys at this offset. */
const PUMP_AMM_GLOBAL = new PublicKey("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const BUYBACK_RECIPIENT_OFFSET = 643;
const BUYBACK_RECIPIENT_COUNT = 8;
/** After the fee-program account, the upgraded sell reads the buyback wallet here. */
const BUYBACK_ACCOUNT_INDEX = 21;
const INFRA_PROGRAMS = new Set([COMPUTE_BUDGET, SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022, ATA_PROGRAM]);
/** Anchor discriminators for the curve buys whose second u64 is max_sol_cost. */
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const BUY_V2_DISCRIMINATOR = Buffer.from([184, 23, 238, 97, 103, 197, 211, 61]);
const SELL_V2_DISCRIMINATOR = Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]);
/** `creator_vault` on buy_v2 and sell_v2. The raw creator pubkey is not an account. */
const CREATOR_VAULT_INDEX = 16;
/**
 * Probe buys are 0.001 SOL. The quoted max_sol_cost is often tighter than the
 * curve, so the sim fails 6002 before the sell runs. 10 SOL is only a sim cap.
 */
export const PROBE_MAX_SOL_LAMPORTS = 10_000_000_000n;
const BURN_OWNERS = new Set([
  "11111111111111111111111111111111",
  "1nc1nerator11111111111111111111111111111111",
]);
/** Buy then sell needs more compute than the single-trade budget the builder returns. */
const ROUND_TRIP_CU = 400_000;

export interface SellSimTrace {
  result: SellSim;
  /** simulateTransaction err, or the builder's error text. */
  err: string | null;
  /** First program log that is not the compute-budget program. */
  log: string | null;
  pool: "pump" | "pump-amm";
  /** Which simulate attempt returned: first pass, no-replace retry, or RPC_URL fallback. */
  attempt: string | null;
}

/** Numeric Anchor / program error, when the simulation err carries one. */
export function simulationErrorCode(err: unknown): number | null {
  const match = JSON.stringify(err ?? null).match(/"Custom":(\d+)/);
  return match ? Number(match[1]) : null;
}

/** First failure log, or the last non-budget program that succeeded. */
export function firstProgramLog(logs: readonly string[] | null | undefined): string | null {
  if (!logs) return null;
  const failure = logs.find((entry) => /Error|AnchorError|failed/i.test(entry) && !/success/i.test(entry));
  if (failure) return failure.slice(0, 240);
  const successes = logs.filter((entry) => /success/i.test(entry) && !entry.includes(COMPUTE_BUDGET));
  const line = successes.length > 0 ? successes[successes.length - 1] : null;
  return line ? line.slice(0, 240) : null;
}

export interface TokenBalanceChange {
  accountIndex?: number;
  mint?: string;
  uiTokenAmount?: { amount?: string };
}

/**
 * A round trip is sellable only when nothing errored, the sell instruction
 * ran, and SOL (WSOL or a transfer after that sell) actually moved.
 */
export function sellExecuted(input: {
  err: unknown;
  logs: readonly string[] | null | undefined;
  preTokenBalances?: readonly TokenBalanceChange[] | null;
  postTokenBalances?: readonly TokenBalanceChange[] | null;
}): boolean {
  if (input.err) return false;
  const logs = input.logs ?? [];
  const at = logs.findIndex((line) => line.includes("Instruction: Sell"));
  if (at < 0) return false;
  const tail = logs.slice(at);
  const sold = tail.some((line) => /success/.test(line) && (line.includes(PUMP_AMM) || line.includes(PUMP_CURVE)));
  if (!sold) return false;
  if (tail.some((line) => /TransferChecked|Transfer /.test(line))) return true;
  const pre = input.preTokenBalances ?? [];
  const post = input.postTokenBalances ?? [];
  for (const row of post) {
    if (row.mint !== WSOL_MINT || row.accountIndex == null) continue;
    const before = pre.find((item) => item.accountIndex === row.accountIndex);
    const prior = BigInt(before?.uiTokenAmount?.amount ?? "0");
    const next = BigInt(row.uiTokenAmount?.amount ?? "0");
    if (next > prior) return true;
  }
  return false;
}

/**
 * Classify a simulateTransaction result. This does not mark a clean success;
 * `sellExecuted` does that. A missing ATA is a setup miss. Every other program
 * error, including 6053, stays a failure. Running out of compute is no verdict.
 */
export function classifySellSimulation(err: unknown, logs: readonly string[] | null | undefined): SellSim {
  const text = `${JSON.stringify(err ?? "")}\n${(logs ?? []).join("\n")}`;
  if (/transfer fee|TransferFee|withheld/i.test(text)) return "transfer-fee";
  if (/exceeded CUs|ProgramFailedToComplete|Computational budget exceeded/i.test(text)) return "unsimulated";
  if (!err) return "fail";
  const code = simulationErrorCode(err);
  if (code === 3012 || /accountnotinitialized/i.test(text)) return "no-balance";
  return "fail";
}

/** First authorized buyback wallet stored on the pump-amm global config. */
export function readBuybackRecipient(data: Uint8Array | Buffer | undefined): PublicKey | null {
  if (!data || data.length < BUYBACK_RECIPIENT_OFFSET + 32) return null;
  for (let i = 0; i < BUYBACK_RECIPIENT_COUNT; i += 1) {
    const start = BUYBACK_RECIPIENT_OFFSET + i * 32;
    if (start + 32 > data.length) return null;
    const key = new PublicKey(data.subarray(start, start + 32));
    if (!key.equals(PublicKey.default)) return key;
  }
  return null;
}

/**
 * The upgraded sell reads the buyback wallet at account 21 and its WSOL ATA
 * at account 22. Trade builders still put an unrelated pubkey at 21, which
 * the program rejects as 6053.
 */
export function repairPumpAmmSell(ix: TransactionInstruction, recipient: PublicKey): TransactionInstruction {
  if (!ix.programId.equals(new PublicKey(PUMP_AMM)) || ix.keys.length < BUYBACK_ACCOUNT_INDEX + 2) return ix;
  const quoteAta = PublicKey.findProgramAddressSync(
    [recipient.toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), new PublicKey(WSOL_MINT).toBuffer()],
    new PublicKey(ATA_PROGRAM),
  )[0];
  const keys = ix.keys.map((key) => ({ pubkey: key.pubkey, isSigner: key.isSigner, isWritable: key.isWritable }));
  keys[BUYBACK_ACCOUNT_INDEX] = { pubkey: recipient, isSigner: false, isWritable: false };
  keys[BUYBACK_ACCOUNT_INDEX + 1] = { pubkey: quoteAta, isSigner: false, isWritable: true };
  return new TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
}

/** Creator pubkey on the bonding-curve account, 32 bytes at offset 49. */
export function readCurveCreator(data: Uint8Array | Buffer | undefined): PublicKey | null {
  if (!data || data.length < 81) return null;
  const key = new PublicKey(data.subarray(49, 81));
  if (key.equals(PublicKey.default)) return null;
  return key;
}

/** `["creator-vault", creator]` on the pump curve program. */
export function creatorVaultPda(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creator.toBuffer()],
    new PublicKey(PUMP_CURVE),
  )[0];
}

function isCurveV2Trade(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  const disc = Buffer.from(data.subarray(0, 8));
  return disc.equals(BUY_V2_DISCRIMINATOR) || disc.equals(SELL_V2_DISCRIMINATOR);
}

function creatorVaultAta(vault: PublicKey, quoteMint: PublicKey, quoteProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [vault.toBuffer(), quoteProgram.toBuffer(), quoteMint.toBuffer()],
    new PublicKey(ATA_PROGRAM),
  )[0];
}

/**
 * Trade-local sometimes keeps a creator_vault PDA from an old creator.
 * Anchor then fails the seeds check with 2006. buy_v2 and sell_v2 do not
 * pass the creator pubkey, so the vault is account 17 and its quote ATA is
 * account 18. Older instructions still carry both keys, and those are swapped
 * as a pair. The creator is the one stored on the curve.
 */
export function repairPumpCreatorVault(ix: TransactionInstruction, creator: PublicKey): TransactionInstruction {
  const program = new PublicKey(PUMP_CURVE);
  if (!ix.programId.equals(program)) return ix;
  const expected = creatorVaultPda(creator);
  const keys = ix.keys.map((key) => ({ pubkey: key.pubkey, isSigner: key.isSigner, isWritable: key.isWritable }));
  if (isCurveV2Trade(ix.data) && keys.length > CREATOR_VAULT_INDEX + 1) {
    const quoteMint = keys[2]?.pubkey;
    const quoteProgram = keys[4]?.pubkey;
    const ata = quoteMint && quoteProgram ? creatorVaultAta(expected, quoteMint, quoteProgram) : null;
    const vaultMeta = keys[CREATOR_VAULT_INDEX]!;
    const ataMeta = keys[CREATOR_VAULT_INDEX + 1]!;
    if (vaultMeta.pubkey.equals(expected) && (ata == null || ataMeta.pubkey.equals(ata))) return ix;
    keys[CREATOR_VAULT_INDEX] = { pubkey: expected, isSigner: vaultMeta.isSigner, isWritable: vaultMeta.isWritable };
    if (ata) {
      keys[CREATOR_VAULT_INDEX + 1] = { pubkey: ata, isSigner: ataMeta.isSigner, isWritable: ataMeta.isWritable };
    }
    return new TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
  }
  if (keys.some((key) => key.pubkey.equals(expected))) return ix;
  let vaultIndex = -1;
  let creatorIndex = -1;
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = 0; j < keys.length; j += 1) {
      if (i === j) continue;
      if (creatorVaultPda(keys[j]!.pubkey).equals(keys[i]!.pubkey)) {
        vaultIndex = i;
        creatorIndex = j;
        break;
      }
    }
    if (vaultIndex >= 0) break;
  }
  if (vaultIndex < 0) return ix;
  const vaultMeta = keys[vaultIndex]!;
  keys[vaultIndex] = { pubkey: expected, isSigner: vaultMeta.isSigner, isWritable: vaultMeta.isWritable };
  if (creatorIndex >= 0) {
    const creatorMeta = keys[creatorIndex]!;
    keys[creatorIndex] = { pubkey: creator, isSigner: creatorMeta.isSigner, isWritable: creatorMeta.isWritable };
  }
  return new TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
}

export function hasRequiredSocial(info: unknown): boolean {
  if (!info || typeof info !== "object") return false;
  const record = info as { socials?: unknown; websites?: unknown };
  const socials = Array.isArray(record.socials) ? record.socials : [];
  for (const item of socials) {
    if (!item || typeof item !== "object") continue;
    const row = item as { type?: unknown; url?: unknown };
    const type = typeof row.type === "string" ? row.type.toLowerCase() : "";
    const url = typeof row.url === "string" ? row.url : "";
    if (url.length > 0 && (type === "twitter" || type === "x" || type === "telegram")) return true;
  }
  const websites = Array.isArray(record.websites) ? record.websites : [];
  for (const item of websites) {
    if (!item || typeof item !== "object") continue;
    const url = (item as { url?: unknown }).url;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return true;
  }
  return false;
}

/**
 * Build a one-token sell and simulate it. The wallet will not hold the mint
 * yet, so a pure missing-balance result is not a honeypot. Any other program
 * error, a transfer fee, or a simulation that cannot be run is a hold.
 */
export interface HoneypotVerdict {
  ok: boolean;
  reason: string | null;
  simErr: string | null;
  simLog: string | null;
  simAttempt: string | null;
  pool: "pump" | "pump-amm" | null;
}

export function createHoneypotCheck(
  config: AppConfig,
  fetcher: typeof fetch = fetch,
): (mint: string, pool?: "pump" | "pump-amm") => Promise<HoneypotVerdict> {
  const connection = new Connection(config.rugCheckRpcUrl, {
    commitment: "processed",
    fetch: fetcher,
    disableRetryOnRateLimit: true,
  });
  const origin = new URL(config.tradeApiUrl).origin;
  return async (mint: string, pool: "pump" | "pump-amm" = "pump") => {
    try {
      const trace = await assessSellability({
        mint,
        pool,
        slippagePct: config.sellSlippagePct,
        tradeUrl: `${origin}/api/trade-local`,
        simulate: (tx) => simulateRoundTrip([config.rugCheckRpcUrl, config.rpcUrl], fetcher, tx, Date.now() + config.scalpSimTimeoutMs),
        loadTable: async (key) => (await connection.getAddressLookupTable(key)).value,
        findHolder: (candidate) => findSellingHolder(connection, candidate),
        loadBuybackRecipient: async () => readBuybackRecipient((await connection.getAccountInfo(PUMP_AMM_GLOBAL))?.data),
        loadCurveCreator: (mint) => loadCurveCreator(connection, mint),
      });
      const code = trace.err != null && /^\d+$/.test(trace.err) ? Number(trace.err) : simulationErrorCode(trace.err);
      const decision = honeypotDecision(trace.result, code);
      return { ...decision, simErr: trace.err, simLog: trace.log, simAttempt: trace.attempt, pool: trace.pool };
    } catch (error) {
      const message = error instanceof Error ? error.message : "simulate-failed";
      return { ok: false, reason: "honeypot_unsimulated", simErr: message.slice(0, 240), simLog: null, simAttempt: null, pool };
    }
  };
}

/**
 * Buy a tiny amount and sell one raw unit in the same simulation, so the
 * payer does not need an existing token account. The pool follows the mint:
 * `pump` for the bonding curve, `pump-amm` after graduation.
 */
export async function assessSellability(input: {
  mint: string;
  pool: "pump" | "pump-amm";
  slippagePct: number;
  tradeUrl: string;
  tradeFetch?: typeof fetch;
  simulate: (tx: VersionedTransaction) => Promise<{
    err: unknown;
    logs: readonly string[] | null;
    preTokenBalances?: readonly TokenBalanceChange[] | null;
    postTokenBalances?: readonly TokenBalanceChange[] | null;
  }>;
  loadTable?: (key: PublicKey) => Promise<AddressLookupTableAccount | null>;
  findHolder?: (mint: string) => Promise<string | null>;
  loadBuybackRecipient?: () => Promise<PublicKey | null>;
  /** Bonding-curve creator, read once per mint. */
  loadCurveCreator?: (mint: string) => Promise<PublicKey | null>;
}): Promise<SellSimTrace> {
  const first = await quoteRoundTrip(input);
  if (first.err !== "6002") return first;
  return quoteRoundTrip(input);
}

async function quoteRoundTrip(input: {
  mint: string;
  pool: "pump" | "pump-amm";
  slippagePct: number;
  tradeUrl: string;
  tradeFetch?: typeof fetch;
  simulate: (tx: VersionedTransaction) => Promise<{
    err: unknown;
    logs: readonly string[] | null;
    preTokenBalances?: readonly TokenBalanceChange[] | null;
    postTokenBalances?: readonly TokenBalanceChange[] | null;
  }>;
  loadTable?: (key: PublicKey) => Promise<AddressLookupTableAccount | null>;
  findHolder?: (mint: string) => Promise<string | null>;
  loadBuybackRecipient?: () => Promise<PublicKey | null>;
  loadCurveCreator?: (mint: string) => Promise<PublicKey | null>;
}): Promise<SellSimTrace> {
  const tradeFetch = input.tradeFetch ?? fetch;
  const recipient = await input.loadBuybackRecipient?.().catch(() => null) ?? null;
  const creator = await input.loadCurveCreator?.(input.mint).catch(() => null) ?? null;
  const buy = await fetchTrade(tradeFetch, input.tradeUrl, tradeBody(input, "buy"));
  if (buy.kind !== "tx") return finish(input.pool, buy.result, buy.err, null, null);
  const sell = await fetchTrade(tradeFetch, input.tradeUrl, tradeBody(input, "sell", SIM_PAYER));
  if (sell.kind !== "tx") return finish(input.pool, sell.result, sell.err, null, null);
  const merged = await mergeRoundTrip(buy.tx, sell.tx, input.loadTable, recipient, creator);
  let simulated: { err: unknown; logs: readonly string[] | null; attempt?: string | null } | null;
  try {
    simulated = merged
      ? await input.simulate(merged)
      : await simulateHolderSell(input, tradeFetch, input.loadTable, recipient, creator);
  } catch (error) {
    const message = error instanceof Error ? error.message : "simulate-failed";
    return finish(input.pool, "unsimulated", message.slice(0, 240), null, null);
  }
  if (!simulated) return finish(input.pool, "unsimulated", "round-trip-too-large", null, null);
  const result = sellExecuted(simulated) ? "ok" : classifySellSimulation(simulated.err, simulated.logs);
  return finish(input.pool, result, simulationErrorText(simulated.err), firstProgramLog(simulated.logs), simulated.attempt ?? null);
}

interface RpcSimValue {
  err: unknown;
  logs: string[] | null;
  preTokenBalances?: TokenBalanceChange[] | null;
  postTokenBalances?: TokenBalanceChange[] | null;
}

/** Keep the JSON-RPC code and the provider's data field, not just "Internal error". */
export function formatRpcError(error: { code?: number; message?: string; data?: unknown } | undefined): string {
  if (!error) return "simulate-failed";
  const data = error.data == null ? "" : typeof error.data === "string" ? error.data : JSON.stringify(error.data);
  return `${error.code ?? ""} ${error.message ?? "simulate-failed"} ${data}`.replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * Some providers (FluxRPC in the paper run) answer simulateTransaction with
 * JSON-RPC -32603 for a versioned buy+sell. A real blockhash without
 * replaceRecentBlockhash, then the main RPC, are the retries.
 */
export async function simulateRoundTrip(
  rpcUrls: readonly string[],
  fetcher: typeof fetch,
  tx: VersionedTransaction,
  deadlineMs = Date.now() + 3_000,
): Promise<RpcSimValue & { attempt: string }> {
  const urls = [...new Set(rpcUrls.filter((url) => url.length > 0))];
  let last = "simulate-failed";
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]!;
    const first = await postSimulate(url, fetcher, tx, true, deadlineMs);
    if (first.ok) return { ...first.value, attempt: index === 0 ? "first pass" : "RPC_URL fallback" };
    last = first.error;
    const blockhash = await latestBlockhash(url, fetcher);
    if (blockhash) {
      tx.message.recentBlockhash = blockhash;
      const second = await postSimulate(url, fetcher, tx, false, deadlineMs);
      if (second.ok) return { ...second.value, attempt: index === 0 ? "no-replace retry" : "RPC_URL fallback" };
      last = second.error;
    }
  }
  throw new Error(last);
}

function rateLimited(status: number, error: string): boolean {
  return status === 429 || /rate limit exceeded|\b429\b/i.test(error);
}

async function postSimulate(
  rpcUrl: string,
  fetcher: typeof fetch,
  tx: VersionedTransaction,
  replaceRecentBlockhash: boolean,
  deadlineMs: number,
): Promise<{ ok: true; value: RpcSimValue } | { ok: false; error: string }> {
  const waits = [0, 200, 400];
  let last = "simulate-failed";
  for (let attempt = 0; attempt < waits.length; attempt += 1) {
    if (attempt > 0) {
      const wait = waits[attempt]!;
      if (Date.now() + wait >= deadlineMs) return { ok: false, error: last };
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    if (Date.now() >= deadlineMs) return { ok: false, error: last };
    const once = await postSimulateOnce(rpcUrl, fetcher, tx, replaceRecentBlockhash);
    if (once.ok) return once;
    last = once.error;
    if (!once.rateLimited || attempt === waits.length - 1) return once;
  }
  return { ok: false, error: last };
}

async function postSimulateOnce(
  rpcUrl: string,
  fetcher: typeof fetch,
  tx: VersionedTransaction,
  replaceRecentBlockhash: boolean,
): Promise<{ ok: true; value: RpcSimValue } | { ok: false; error: string; rateLimited: boolean }> {
  try {
    const response = await fetcher(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateTransaction",
        params: [
          Buffer.from(tx.serialize()).toString("base64"),
          {
            encoding: "base64",
            sigVerify: false,
            commitment: "processed",
            ...(replaceRecentBlockhash ? { replaceRecentBlockhash: true } : {}),
          },
        ],
      }),
    });
    if (response.status === 429) {
      const text = await response.text();
      const error = `429 ${text}`.slice(0, 240);
      return { ok: false, error, rateLimited: true };
    }
    const payload = (await response.json()) as {
      error?: { code?: number; message?: string; data?: unknown };
      result?: { value?: RpcSimValue };
    };
    if (payload.error || !payload.result?.value) {
      const error = formatRpcError(payload.error);
      return { ok: false, error, rateLimited: rateLimited(response.status, error) };
    }
    const value = payload.result.value;
    return {
      ok: true,
      value: {
        err: value.err ?? null,
        logs: value.logs ?? null,
        preTokenBalances: value.preTokenBalances ?? null,
        postTokenBalances: value.postTokenBalances ?? null,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "simulate-failed";
    const text = message.slice(0, 240);
    return { ok: false, error: text, rateLimited: rateLimited(0, text) };
  }
}

async function latestBlockhash(rpcUrl: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    const response = await fetcher(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getLatestBlockhash",
        params: [{ commitment: "processed" }],
      }),
    });
    const payload = (await response.json()) as { result?: { value?: { blockhash?: string } } };
    return payload.result?.value?.blockhash ?? null;
  } catch {
    return null;
  }
}

function tradeBody(
  input: { mint: string; pool: "pump" | "pump-amm"; slippagePct: number },
  action: "buy" | "sell",
  publicKey = SIM_PAYER,
): Record<string, unknown> {
  return {
    publicKey,
    action,
    mint: input.mint,
    amount: action === "buy" ? 0.001 : 1,
    denominatedInSol: action === "buy" ? "true" : "false",
    slippage: input.slippagePct,
    pool: input.pool,
  };
}

type FetchedTrade =
  | { kind: "tx"; tx: VersionedTransaction }
  | { kind: "stop"; result: SellSim; err: string | null };

async function fetchTrade(tradeFetch: typeof fetch, url: string, body: Record<string, unknown>): Promise<FetchedTrade> {
  const response = await tradeFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok && bytes.length === 0) return { kind: "stop", result: "unsimulated", err: `http ${response.status}` };
  try {
    return { kind: "tx", tx: VersionedTransaction.deserialize(bytes) };
  } catch {
    const text = Buffer.from(bytes).toString("utf8");
    if (/balance|token account|no record|not initialized/i.test(text)) {
      return { kind: "stop", result: "no-balance", err: text.slice(0, 240) };
    }
    try {
      return { kind: "tx", tx: VersionedTransaction.deserialize(parseBundleTransaction(JSON.parse(text))) };
    } catch {
      return { kind: "stop", result: "unsimulated", err: text.slice(0, 240) };
    }
  }
}

/**
 * Raise max_sol_cost on a probe buy. A 6002 here is the quote's own slippage
 * bound, not a token that cannot be sold. Sells are left alone.
 */
export function relaxProbeMaxSol(ix: TransactionInstruction): TransactionInstruction {
  const program = new PublicKey(PUMP_CURVE);
  if (!ix.programId.equals(program) || ix.data.length < 24) return ix;
  const disc = Buffer.from(ix.data.subarray(0, 8));
  if (!disc.equals(BUY_DISCRIMINATOR) && !disc.equals(BUY_V2_DISCRIMINATOR)) return ix;
  if (ix.data.readBigUInt64LE(16) >= PROBE_MAX_SOL_LAMPORTS) return ix;
  const data = Buffer.from(ix.data);
  data.writeBigUInt64LE(PROBE_MAX_SOL_LAMPORTS, 16);
  return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
}

function repairInstruction(ix: TransactionInstruction, recipient: PublicKey | null, creator: PublicKey | null): TransactionInstruction {
  let next = relaxProbeMaxSol(ix);
  if (recipient) next = repairPumpAmmSell(next, recipient);
  if (creator) next = repairPumpCreatorVault(next, creator);
  return next;
}

async function mergeRoundTrip(
  buy: VersionedTransaction,
  sell: VersionedTransaction,
  loadTable?: (key: PublicKey) => Promise<AddressLookupTableAccount | null>,
  recipient?: PublicKey | null,
  creator?: PublicKey | null,
): Promise<VersionedTransaction | null> {
  const keys = new Map<string, PublicKey>();
  for (const tx of [buy, sell]) {
    for (const lookup of tx.message.addressTableLookups) keys.set(lookup.accountKey.toBase58(), lookup.accountKey);
  }
  const tables: AddressLookupTableAccount[] = [];
  for (const key of keys.values()) {
    const table = await loadTable?.(key);
    if (table) tables.push(table);
  }
  const buyIxs = TransactionMessage.decompile(buy.message, { addressLookupTableAccounts: tables }).instructions
    .filter((ix) => ix.programId.toBase58() !== COMPUTE_BUDGET)
    .map((ix) => repairInstruction(ix, recipient ?? null, creator ?? null));
  const sellIxs = TransactionMessage.decompile(sell.message, { addressLookupTableAccounts: tables }).instructions
    .filter((ix) => ix.programId.toBase58() !== COMPUTE_BUDGET)
    .map((ix) => repairInstruction(ix, recipient ?? null, creator ?? null));
  const sellTrade = sellIxs.filter((ix) => !INFRA_PROGRAMS.has(ix.programId.toBase58()));
  let lastBuyTrade = -1;
  for (let i = buyIxs.length - 1; i >= 0; i -= 1) {
    if (!INFRA_PROGRAMS.has(buyIxs[i]!.programId.toBase58())) {
      lastBuyTrade = i;
      break;
    }
  }
  const buyThroughTrade = lastBuyTrade >= 0 ? buyIxs.slice(0, lastBuyTrade + 1) : buyIxs;
  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: ROUND_TRIP_CU });
  const candidates = [
    [budget, ...buyIxs, ...sellIxs],
    [budget, ...buyThroughTrade, ...sellTrade],
    [...buyThroughTrade, ...sellTrade],
  ];
  for (const instructions of candidates) {
    if (instructions.length === 0) continue;
    const packed = pack(instructions, tables);
    if (packed) return packed;
  }
  return null;
}

function pack(instructions: TransactionInstruction[], tables: AddressLookupTableAccount[]): VersionedTransaction | null {
  try {
    const message = new TransactionMessage({
      payerKey: new PublicKey(SIM_PAYER),
      recentBlockhash: "11111111111111111111111111111111",
      instructions,
    }).compileToV0Message(tables);
    const tx = new VersionedTransaction(message);
    if (tx.serialize().length > 1232) return null;
    return tx;
  } catch {
    return null;
  }
}

async function simulateHolderSell(
  input: {
    mint: string;
    pool: "pump" | "pump-amm";
    slippagePct: number;
    tradeUrl: string;
    simulate: (tx: VersionedTransaction) => Promise<{
      err: unknown;
      logs: readonly string[] | null;
      preTokenBalances?: readonly TokenBalanceChange[] | null;
      postTokenBalances?: readonly TokenBalanceChange[] | null;
      attempt?: string | null;
    }>;
    findHolder?: (mint: string) => Promise<string | null>;
  },
  tradeFetch: typeof fetch,
  loadTable?: (key: PublicKey) => Promise<AddressLookupTableAccount | null>,
  recipient?: PublicKey | null,
  creator?: PublicKey | null,
): Promise<{ err: unknown; logs: readonly string[] | null; attempt?: string | null } | null> {
  const holder = await input.findHolder?.(input.mint).catch(() => null);
  if (!holder) return null;
  const sell = await fetchTrade(tradeFetch, input.tradeUrl, tradeBody(input, "sell", holder));
  if (sell.kind !== "tx") return { err: sell.err, logs: sell.err ? [sell.err] : null };
  const repaired = await mergeRoundTrip(sell.tx, sell.tx, loadTable, recipient, creator);
  return input.simulate(repaired ?? sell.tx);
}

async function loadCurveCreator(connection: Connection, mint: string): Promise<PublicKey | null> {
  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return null;
  }
  const [curve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintKey.toBuffer()],
    new PublicKey(PUMP_CURVE),
  );
  const info = await connection.getAccountInfo(curve);
  return readCurveCreator(info?.data);
}

/** A wallet that actually holds the mint, so a sell is not rejected for a missing ATA. */
export async function findSellingHolder(connection: Connection, mint: string): Promise<string | null> {
  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return null;
  }
  const protocol = protocolHolders(mintKey);
  const skip = new Set([...protocol.owners, ...protocol.addresses, ...BURN_OWNERS]);
  const largest = await connection.getTokenLargestAccounts(mintKey);
  const rows = largest.value.filter((row) => row.amount !== "0").slice(0, 8);
  if (rows.length === 0) return null;
  const infos = await connection.getMultipleAccountsInfo(rows.map((row) => row.address));
  for (let i = 0; i < rows.length; i += 1) {
    const data = infos[i]?.data;
    if (!data || data.length < 64) continue;
    const owner = new PublicKey(data.subarray(32, 64)).toBase58();
    if (skip.has(owner) || skip.has(rows[i]!.address.toBase58())) continue;
    return owner;
  }
  return null;
}

function simulationErrorText(err: unknown): string | null {
  if (!err) return null;
  const code = simulationErrorCode(err);
  return code != null ? String(code) : JSON.stringify(err).slice(0, 240);
}

function finish(
  pool: "pump" | "pump-amm",
  result: SellSim,
  err: string | null,
  log: string | null,
  attempt: string | null,
): SellSimTrace {
  return { result, err, log, pool, attempt };
}
