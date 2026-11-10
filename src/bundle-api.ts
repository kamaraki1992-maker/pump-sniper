import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { AppConfig } from "./config.js";
import {
  cuLimitFromConsumed,
  microLamportsForFee,
  rewriteTransaction,
  tipLamports,
} from "./compute.js";
import type { OrderRequest } from "./types.js";

export interface BundleBody {
  accounts: Array<{
    publicKey: string;
    type: "buy" | "sell";
    amount: number | string;
    denominatedInSol: string;
    creator?: string;
  }>;
  mint: string;
  jitoTip: number;
  slippage: number;
  priorityFee: number;
  /** Present on a graduated sell. PumpDev routes the swap to PumpSwap. */
  pool?: "pump-amm" | "auto";
}

/**
 * Same trade fields as PumpDev's Lightning trade (`action`, `mint`, `amount`,
 * `denominatedInSol`, `slippage`), placed on one local-sign bundle account.
 * `jitoTip` is a bundle field. The private key is not part of the body.
 */
function sellAmount(order: OrderRequest): number | string {
  const fraction = order.sellFraction ?? 1;
  if (!(fraction > 0) || fraction >= 0.999) return "100%";
  const pct = Math.round(fraction * 10_000) / 100;
  return `${pct}%`;
}

export function buildBundleBody(publicKey: string, order: OrderRequest, config: AppConfig): BundleBody {
  const sell = order.reason !== "entry";
  const account: BundleBody["accounts"][number] = {
    publicKey,
    type: sell ? "sell" : "buy",
    amount: sell ? sellAmount(order) : order.sizeSol,
    denominatedInSol: sell ? "false" : "true",
  };
  if (order.creator) account.creator = order.creator;
  return {
    accounts: [account],
    mint: order.mint,
    jitoTip: order.tipSol != null && order.tipSol >= 0 ? order.tipSol : config.jitoTipSol,
    slippage: order.slippagePct,
    // Compute price is rewritten locally after simulation.
    priorityFee: 0,
    ...(order.pool ? { pool: order.pool } : {}),
  };
}

export function parseBundleTransaction(payload: unknown): Uint8Array {
  if (!payload || typeof payload !== "object") {
    throw new Error("bundle response was empty");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.length > 0) {
    throw new Error(record.error);
  }
  const transactions = record.transactions;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw new Error("bundle response did not include a transaction");
  }
  const first = transactions[0] as Record<string, unknown> | undefined;
  const encoded = first?.transaction;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("bundle transaction field was empty");
  }
  try {
    return bs58.decode(encoded);
  } catch {
    return Buffer.from(encoded, "base64");
  }
}

export async function fetchUnsignedBundle(
  config: AppConfig,
  publicKey: string,
  order: OrderRequest,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetcher(config.tradeApiUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(buildBundleBody(publicKey, order, config)),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`bundle HTTP ${response.status}`);
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `bundle HTTP ${response.status}`;
    throw new Error(message);
  }
  return parseBundleTransaction(parsed);
}

export async function loadLookupTables(
  connection: Connection,
  tx: VersionedTransaction,
): Promise<AddressLookupTableAccount[]> {
  const lookups = tx.message.addressTableLookups;
  if (!lookups || lookups.length === 0) return [];
  const tables: AddressLookupTableAccount[] = [];
  for (const lookup of lookups) {
    const loaded = await connection.getAddressLookupTable(lookup.accountKey);
    if (loaded.value) tables.push(loaded.value);
  }
  return tables;
}

export function applyDynamicCompute(
  tx: VersionedTransaction,
  tables: AddressLookupTableAccount[],
  opts: {
    unitsConsumed: number | null;
    priorityFeeSol: number;
    tipSol: number;
    tipAccount: PublicKey;
    payer: PublicKey;
    recentBlockhash?: string;
  },
): VersionedTransaction {
  const decompiled = TransactionMessage.decompile(tx.message, {
    addressLookupTableAccounts: tables,
  });
  const cuLimit = cuLimitFromConsumed(opts.unitsConsumed);
  return rewriteTransaction(tx, decompiled, {
    cuLimit,
    microLamports: microLamportsForFee(opts.priorityFeeSol, cuLimit),
    tipLamports: tipLamports(opts.tipSol),
    tipAccount: opts.tipAccount,
    payer: opts.payer,
    addressLookupTableAccounts: tables,
    ...(opts.recentBlockhash ? { recentBlockhash: opts.recentBlockhash } : {}),
  });
}
