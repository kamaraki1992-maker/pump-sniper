import { Connection, VersionedTransaction } from "@solana/web3.js";
import { parseBundleTransaction } from "./bundle-api.js";
import type { AppConfig } from "./config.js";

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Token-2022 TLV extension type for a transfer fee on the mint. */
export const EXT_TRANSFER_FEE_CONFIG = 1;
/** Token-2022 TLV extension type for a transfer hook. */
export const EXT_TRANSFER_HOOK = 14;

export interface MintInspection {
  ok: boolean;
  reason: string | null;
}

/**
 * Reject a mint whose authority can still mint or freeze, or a program that
 * is not SPL Token / Token-2022. Token-2022 is allowed only without a
 * transfer fee or a transfer hook.
 */
export function inspectMintAccount(owner: string, data: Uint8Array): MintInspection {
  if (owner !== TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) {
    return { ok: false, reason: "unsupported-token-program" };
  }
  if (data.byteLength < 82) return { ok: false, reason: "mint-too-small" };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 0) return { ok: false, reason: "mint-authority-set" };
  if (view.getUint32(46, true) !== 0) return { ok: false, reason: "freeze-authority-set" };
  if (owner === TOKEN_2022_PROGRAM_ID) {
    const extensions = readToken2022Extensions(data);
    if (extensions.has(EXT_TRANSFER_FEE_CONFIG)) return { ok: false, reason: "transfer-fee" };
    if (extensions.has(EXT_TRANSFER_HOOK)) return { ok: false, reason: "transfer-hook" };
  }
  return { ok: true, reason: null };
}

/** TLV starts at byte 166 (165-byte header, then the account-type byte). */
export function readToken2022Extensions(data: Uint8Array): Set<number> {
  const found = new Set<number>();
  let offset = 166;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (offset + 4 <= data.byteLength) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    if (length < 0 || offset + 4 + length > data.byteLength) break;
    if (type !== 0) found.add(type);
    offset += 4 + length;
    const pad = offset % 4;
    if (pad !== 0) offset += 4 - pad;
  }
  return found;
}

/**
 * Constant-product round trip at the current virtual reserves. A zero token
 * out or a non-finite sell quote fails the check. This is the sell leg we can
 * evaluate before the wallet holds the mint.
 */
export function curveRoundTrip(
  vSol: number,
  vTokens: number,
  spendSol: number,
): { ok: boolean; tokensOut: number; sellSol: number } {
  if (!(vSol > 0) || !(vTokens > 0) || !(spendSol > 0)) {
    return { ok: false, tokensOut: 0, sellSol: 0 };
  }
  const k = vSol * vTokens;
  const solAfterBuy = vSol + spendSol;
  const tokensAfterBuy = k / solAfterBuy;
  const tokensOut = vTokens - tokensAfterBuy;
  if (!(tokensOut > 0) || !Number.isFinite(tokensOut)) {
    return { ok: false, tokensOut: 0, sellSol: 0 };
  }
  const tokensAfterSell = tokensAfterBuy + tokensOut;
  const solAfterSell = k / tokensAfterSell;
  const sellSol = solAfterBuy - solAfterSell;
  if (!(sellSol > 0) || !Number.isFinite(sellSol)) {
    return { ok: false, tokensOut, sellSol: 0 };
  }
  return { ok: true, tokensOut, sellSol };
}

export interface SafetyCheckResult {
  ok: boolean;
  reason: string | null;
  latencyMs: number;
}

export interface SafetyWork {
  owner: string;
  data: Uint8Array;
  vSol: number | null;
  vTokens: number | null;
  spendSol: number;
  /** `no-balance` is the expected pre-buy sell result and does not reject. */
  simulate?: () => Promise<{ buy: "ok" | "fail" | "no-balance"; sell: "ok" | "no-balance" | "fail" }>;
}

export async function runSafetyCheck(
  work: () => Promise<SafetyWork>,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<SafetyCheckResult> {
  const started = now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const raced = await Promise.race([
    work()
      .then((value) => ({ kind: "value" as const, value }))
      .catch((error: unknown) => ({ kind: "error" as const, error })),
    timeout.then(() => ({ kind: "timeout" as const })),
  ]);
  if (timer) clearTimeout(timer);
  const latencyMs = Math.max(0, now() - started);
  if (raced.kind === "timeout") {
    return { ok: false, reason: "safety_timeout", latencyMs: Math.max(latencyMs, timeoutMs) };
  }
  if (raced.kind === "error") {
    const message = raced.error instanceof Error ? raced.error.message : "safety-error";
    return { ok: false, reason: message, latencyMs };
  }
  const inspected = inspectMintAccount(raced.value.owner, raced.value.data);
  if (!inspected.ok) return { ok: false, reason: inspected.reason, latencyMs };
  if (raced.value.vSol === null || raced.value.vTokens === null) {
    return { ok: false, reason: "curve-reserves-missing", latencyMs };
  }
  const trip = curveRoundTrip(raced.value.vSol, raced.value.vTokens, raced.value.spendSol);
  if (!trip.ok) return { ok: false, reason: "curve-round-trip-failed", latencyMs };
  if (raced.value.simulate) {
    const sim = await raced.value.simulate();
    if (sim.buy === "fail") return { ok: false, reason: "buy-simulation-failed", latencyMs: Math.max(0, now() - started) };
    if (sim.sell === "fail") return { ok: false, reason: "sell-simulation-failed", latencyMs: Math.max(0, now() - started) };
  }
  return { ok: true, reason: null, latencyMs: Math.max(0, now() - started) };
}

/**
 * Unsigned simulations need a fee payer that already holds SOL, or the RPC
 * rejects the transaction before the pump instruction runs. This is a public
 * mainnet account. sigVerify is off, so the simulation does not spend its funds.
 */
const SIM_PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/**
 * On-chain mint read plus a buy simulation. The sell simulation uses the same
 * builder. A sell that fails only because the simulation payer does not hold
 * the mint yet is not a rejection: the buy has not landed. Other simulation
 * errors reject the token.
 */
export function createRpcSafetyCheck(config: AppConfig, rpcFetch: typeof fetch = fetch): (input: {
  mint: string;
  vSol: number | null;
  vTokens: number | null;
  spendSol: number;
}) => Promise<SafetyCheckResult> {
  const connection = new Connection(config.rpcUrl, {
    commitment: "processed",
    fetch: rpcFetch,
    disableRetryOnRateLimit: true,
  });
  return (input) =>
    runSafetyCheck(async () => {
      const account = await fetchMint(config.rpcUrl, input.mint, rpcFetch);
      const simulate = async () => {
        const buy = await simulateTrade(connection, config, input.mint, input.spendSol, "buy");
        const sell = await simulateTrade(connection, config, input.mint, "100%", "sell");
        return { buy, sell };
      };
      return {
        owner: account.owner,
        data: account.data,
        vSol: input.vSol,
        vTokens: input.vTokens,
        spendSol: input.spendSol,
        simulate,
      };
    }, config.safetyCheckTimeoutMs);
}

async function fetchMint(
  rpcUrl: string,
  mint: string,
  rpcFetch: typeof fetch,
): Promise<{ owner: string; data: Uint8Array }> {
  const response = await rpcFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [mint, { encoding: "base64" }],
    }),
  });
  if (!response.ok) throw new Error(`mint rpc HTTP ${response.status}`);
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: { value?: { owner?: string; data?: [string, string] } | null };
  };
  if (payload.error) throw new Error(payload.error.message ?? "mint rpc error");
  const value = payload.result?.value;
  const encoded = value?.data?.[0];
  if (!value?.owner || !encoded) throw new Error("mint-account-missing");
  return { owner: value.owner, data: Buffer.from(encoded, "base64") };
}

async function simulateTrade(
  connection: Connection,
  config: AppConfig,
  mint: string,
  amount: number | string,
  action: "buy" | "sell",
): Promise<"ok" | "no-balance" | "fail"> {
  const origin = new URL(config.tradeApiUrl).origin;
  const response = await fetch(`${origin}/api/trade-local`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: SIM_PAYER,
      action,
      mint,
      amount,
      denominatedInSol: action === "buy" ? "true" : "false",
      slippage: config.maxSlippagePct,
    }),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const text = Buffer.from(bytes).toString("utf8");
    if (action === "sell" && /balance|token account|no record/i.test(text)) return "no-balance";
    return "fail";
  }
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch {
    const text = Buffer.from(bytes).toString("utf8");
    if (action === "sell") return "no-balance";
    try {
      tx = VersionedTransaction.deserialize(parseBundleTransaction(JSON.parse(text)));
    } catch {
      return "fail";
    }
  }
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
  });
  if (!sim.value.err) return "ok";
  const text = JSON.stringify(sim.value.err);
  if (action === "sell" && /insufficient|0x1|custom":1|token account|no record of a prior credit/i.test(text)) {
    return "no-balance";
  }
  if (/insufficient/i.test(text) && text.length < 80) return "no-balance";
  return "fail";
}
