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
        simulate: (tx) => simulateRoundTrip(config.rugCheckRpcUrl, fetcher, tx),
        loadTable: async (key) => (await connection.getAddressLookupTable(key)).value,
        findHolder: (candidate) => findSellingHolder(connection, candidate),
        loadBuybackRecipient: async () => readBuybackRecipient((await connection.getAccountInfo(PUMP_AMM_GLOBAL))?.data),
      });
      const code = trace.err != null && /^\d+$/.test(trace.err) ? Number(trace.err) : simulationErrorCode(trace.err);
      const decision = honeypotDecision(trace.result, code);
      return { ...decision, simErr: trace.err, simLog: trace.log, pool: trace.pool };
    } catch {
      return { ok: false, reason: "honeypot_unsimulated", simErr: null, simLog: null, pool };
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
}): Promise<SellSimTrace> {
  const tradeFetch = input.tradeFetch ?? fetch;
  const recipient = await input.loadBuybackRecipient?.().catch(() => null) ?? null;
  const buy = await fetchTrade(tradeFetch, input.tradeUrl, tradeBody(input, "buy"));
  if (buy.kind !== "tx") return finish(input.pool, buy.result, buy.err, null);
  const sell = await fetchTrade(tradeFetch, input.tradeUrl, tradeBody(input, "sell", SIM_PAYER));
  if (sell.kind !== "tx") return finish(input.pool, sell.result, sell.err, null);
  const merged = await mergeRoundTrip(buy.tx, sell.tx, input.loadTable, recipient);
  let simulated: { err: unknown; logs: readonly string[] | null } | null;
  try {
    simulated = merged ? await input.simulate(merged) : await simulateHolderSell(input, tradeFetch);
  } catch (error) {
    const message = error instanceof Error ? error.message : "simulate-failed";
    return finish(input.pool, "unsimulated", message.slice(0, 240), null);
  }
  if (!simulated) return finish(input.pool, "unsimulated", "round-trip-too-large", null);
  const result = sellExecuted(simulated) ? "ok" : classifySellSimulation(simulated.err, simulated.logs);
  return finish(input.pool, result, simulationErrorText(simulated.err), firstProgramLog(simulated.logs));
}

async function simulateRoundTrip(
  rpcUrl: string,
  fetcher: typeof fetch,
  tx: VersionedTransaction,
): Promise<{
  err: unknown;
  logs: string[] | null;
  preTokenBalances: TokenBalanceChange[] | null;
  postTokenBalances: TokenBalanceChange[] | null;
}> {
  const response = await fetcher(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [
        Buffer.from(tx.serialize()).toString("base64"),
        { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" },
      ],
    }),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: { value?: {
      err?: unknown;
      logs?: string[] | null;
      preTokenBalances?: TokenBalanceChange[] | null;
      postTokenBalances?: TokenBalanceChange[] | null;
    } };
  };
  if (payload.error) throw new Error(payload.error.message ?? "simulate-failed");
  const value = payload.result?.value;
  if (!value) throw new Error("simulate-empty");
  return {
    err: value.err ?? null,
    logs: value.logs ?? null,
    preTokenBalances: value.preTokenBalances ?? null,
    postTokenBalances: value.postTokenBalances ?? null,
  };
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

async function mergeRoundTrip(
  buy: VersionedTransaction,
  sell: VersionedTransaction,
  loadTable?: (key: PublicKey) => Promise<AddressLookupTableAccount | null>,
  recipient?: PublicKey | null,
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
    .filter((ix) => ix.programId.toBase58() !== COMPUTE_BUDGET);
  const sellIxs = TransactionMessage.decompile(sell.message, { addressLookupTableAccounts: tables }).instructions
    .filter((ix) => ix.programId.toBase58() !== COMPUTE_BUDGET)
    .map((ix) => (recipient ? repairPumpAmmSell(ix, recipient) : ix));
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
    }>;
    findHolder?: (mint: string) => Promise<string | null>;
  },
  tradeFetch: typeof fetch,
): Promise<{ err: unknown; logs: readonly string[] | null } | null> {
  const holder = await input.findHolder?.(input.mint).catch(() => null);
  if (!holder) return null;
  const sell = await fetchTrade(tradeFetch, input.tradeUrl, tradeBody(input, "sell", holder));
  if (sell.kind !== "tx") return { err: sell.err, logs: sell.err ? [sell.err] : null };
  return input.simulate(sell.tx);
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

function finish(pool: "pump" | "pump-amm", result: SellSim, err: string | null, log: string | null): SellSimTrace {
  return { result, err, log, pool };
}
