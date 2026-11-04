import {
  Connection,
  PublicKey,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { applyDynamicCompute, fetchUnsignedBundle, loadLookupTables } from "./bundle-api.js";
import type { AppConfig } from "./config.js";
import { pickTipAccount } from "./compute.js";
import type { Executor, FillResult, OrderRequest } from "./types.js";

export interface ConfirmResult {
  state: "landed" | "failed" | "expired";
  error?: string;
  /** Wallet SOL change in SOL. Negative on buys. */
  solDelta?: number | null;
}

export interface LivePorts {
  publicKey: PublicKey;
  sign(tx: VersionedTransaction): void;
  buildUnsignedTx(order: OrderRequest): Promise<Uint8Array>;
  simulate(tx: VersionedTransaction): Promise<{ unitsConsumed: number | null; err: string | null }>;
  lookupTables(tx: VersionedTransaction): Promise<AddressLookupTableAccount[]>;
  sendBundle(tx: VersionedTransaction): Promise<{ bundleId: string; signature: string }>;
  confirm(signature: string): Promise<ConfirmResult>;
  tipAccount: PublicKey;
  config: AppConfig;
}

function blank(order: OrderRequest, error: string, signature = ""): FillResult {
  return {
    status: "failed",
    signature,
    solscan: signature ? `https://solscan.io/tx/${signature}` : null,
    price: 0,
    sizeSol: 0,
    tokenAmount: 0,
    feesSol: 0,
    jitoTipSol: 0,
    cashflowSol: 0,
    error,
  };
}

function classifySimError(err: string): string {
  if (/slippage|0x1771|exceeded/i.test(err)) return `slippage-exceeded: ${err}`;
  return err;
}

export function liveFillFromConfirm(
  order: OrderRequest,
  signature: string,
  confirm: ConfirmResult,
  estimate: { price: number; tokenAmount: number; feesSol: number; tipSol: number; cashflowSol: number },
): FillResult {
  const solscan = `https://solscan.io/tx/${signature}`;
  if (confirm.state === "expired") {
    return blank(order, "bundle-not-landed", signature);
  }
  if (confirm.state === "failed") {
    const error = confirm.error ? classifySimError(confirm.error) : "transaction-failed";
    return blank(order, error, signature);
  }
  const delta = confirm.solDelta;
  if (order.reason === "entry") {
    const cost = delta !== undefined && delta !== null && delta < 0 ? -delta : estimate.cashflowSol;
    const fees = Math.max(0, cost - order.sizeSol - estimate.tipSol);
    return {
      status: "filled",
      signature,
      solscan,
      price: estimate.price,
      sizeSol: order.sizeSol,
      tokenAmount: estimate.tokenAmount,
      feesSol: fees > 0 ? fees : estimate.feesSol,
      jitoTipSol: estimate.tipSol,
      cashflowSol: cost,
      error: null,
    };
  }
  const proceeds = delta !== undefined && delta !== null && delta > 0 ? delta : estimate.cashflowSol;
  return {
    status: "filled",
    signature,
    solscan,
    price: estimate.price,
    sizeSol: proceeds,
    tokenAmount: order.tokenAmount ?? estimate.tokenAmount,
    feesSol: estimate.feesSol,
    jitoTipSol: estimate.tipSol,
    cashflowSol: proceeds,
    error: null,
  };
}

/**
 * Live execution builds an unsigned PumpDev bundle, simulates it, sets a
 * dynamic compute-unit limit and price, signs locally, and submits one
 * transaction as a Jito bundle. A returned bundle id is not a fill.
 */
export class LiveExecutor implements Executor {
  constructor(private readonly ports: LivePorts) {}

  async buy(order: OrderRequest): Promise<FillResult> {
    return this.execute(order);
  }

  async sell(order: OrderRequest): Promise<FillResult> {
    return this.execute(order);
  }

  private async execute(order: OrderRequest): Promise<FillResult> {
    let raw: Uint8Array;
    try {
      raw = await this.ports.buildUnsignedTx(order);
    } catch (error) {
      return blank(order, error instanceof Error ? error.message : "bundle-build-failed");
    }

    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(raw);
    } catch {
      return blank(order, "bundle-decode-failed");
    }

    const sim = await this.ports.simulate(tx);
    if (sim.err) return blank(order, classifySimError(sim.err));

    let prepared: VersionedTransaction;
    try {
      const tables = await this.ports.lookupTables(tx);
      prepared = applyDynamicCompute(tx, tables, {
        unitsConsumed: sim.unitsConsumed,
        priorityFeeSol: this.ports.config.priorityFeeSol,
        tipSol: this.ports.config.jitoTipSol,
        tipAccount: this.ports.tipAccount,
        payer: this.ports.publicKey,
      });
    } catch (error) {
      return blank(order, error instanceof Error ? error.message : "tx-prepare-failed");
    }

    try {
      this.ports.sign(prepared);
    } catch {
      return blank(order, "sign-failed");
    }

    let sent: { bundleId: string; signature: string };
    try {
      sent = await this.ports.sendBundle(prepared);
    } catch (error) {
      return blank(order, error instanceof Error ? error.message : "bundle-send-failed");
    }

    const confirm = await this.ports.confirm(sent.signature);
    const estimate = {
      price: order.quotePriceSol,
      tokenAmount: order.tokenAmount ?? 0,
      feesSol: this.ports.config.priorityFeeSol + this.ports.config.paper.baseFeeSol,
      tipSol: this.ports.config.jitoTipSol,
      cashflowSol:
        order.reason === "entry"
          ? order.sizeSol + this.ports.config.jitoTipSol + this.ports.config.priorityFeeSol
          : 0,
    };
    return liveFillFromConfirm(order, sent.signature, confirm, estimate);
  }
}

export function createLivePorts(
  config: AppConfig,
  keypair: Keypair,
  connection: Connection,
): LivePorts {
  return {
    publicKey: keypair.publicKey,
    config,
    tipAccount: pickTipAccount(),
    sign: (tx) => {
      tx.sign([keypair]);
    },
    buildUnsignedTx: (order) => fetchUnsignedBundle(config, keypair.publicKey.toBase58(), order),
    lookupTables: (tx) => loadLookupTables(connection, tx),
    simulate: async (tx) => {
      const result = await connection.simulateTransaction(tx, {
        replaceRecentBlockhash: true,
        sigVerify: false,
        commitment: "processed",
      });
      const err = result.value.err;
      return {
        unitsConsumed: result.value.unitsConsumed ?? null,
        err: err ? JSON.stringify(err) : null,
      };
    },
    sendBundle: async (tx) => {
      const signature = bs58.encode(tx.signatures[0] ?? new Uint8Array());
      const encoded = Buffer.from(tx.serialize()).toString("base64");
      const response = await fetch(config.jitoBlockEngineUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [[encoded], { encoding: "base64" }],
        }),
      });
      const body = (await response.json()) as {
        result?: string;
        error?: { message?: string };
      };
      if (!response.ok || body.error || !body.result) {
        throw new Error(body.error?.message ?? `jito HTTP ${response.status}`);
      }
      return { bundleId: body.result, signature };
    },
    confirm: (signature) => confirmSignature(connection, signature, config.confirmTimeoutMs),
  };
}

export async function confirmSignature(
  connection: Connection,
  signature: string,
  timeoutMs: number,
): Promise<ConfirmResult> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await connection.getSignatureStatuses([signature]);
    const row = status.value[0];
    if (row?.err) {
      return { state: "failed", error: JSON.stringify(row.err), solDelta: null };
    }
    if (row && (row.confirmationStatus === "confirmed" || row.confirmationStatus === "finalized")) {
      const solDelta = await readSolDelta(connection, signature);
      return { state: "landed", solDelta };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { state: "expired", solDelta: null };
}

async function readSolDelta(connection: Connection, signature: string): Promise<number | null> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta) return null;
  const pre = tx.meta.preBalances[0];
  const post = tx.meta.postBalances[0];
  if (pre === undefined || post === undefined) return null;
  return (post - pre) / 1e9;
}
