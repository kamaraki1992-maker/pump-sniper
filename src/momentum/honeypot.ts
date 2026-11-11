import { Connection, VersionedTransaction } from "@solana/web3.js";
import { parseBundleTransaction } from "../bundle-api.js";
import type { AppConfig } from "../config.js";

/**
 * Same public payer the sniper sim uses. sigVerify is off, so the simulation
 * does not spend its funds. A sell still fails when that account holds none
 * of the mint; that missing balance is not a honeypot.
 */
const SIM_PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

export type SellSim = "ok" | "fail" | "transfer-fee" | "no-balance" | "unsimulated";

export function honeypotDecision(result: SellSim): { ok: boolean; reason: string | null } {
  if (result === "ok" || result === "no-balance") return { ok: true, reason: null };
  if (result === "transfer-fee") return { ok: false, reason: "transfer-fee" };
  if (result === "unsimulated") return { ok: false, reason: "honeypot_unsimulated" };
  return { ok: false, reason: "honeypot" };
}

/** Classify a simulateTransaction result. A transfer fee fails even when the RPC returns ok. */
export function classifySellSimulation(err: unknown, logs: readonly string[] | null | undefined): SellSim {
  const text = `${JSON.stringify(err ?? "")}\n${(logs ?? []).join("\n")}`;
  if (/transfer fee|TransferFee|withheld/i.test(text)) return "transfer-fee";
  if (!err) return "ok";
  if (/insufficient|0x1|custom":1|token account|no record of a prior credit|no balance/i.test(text)) {
    return "no-balance";
  }
  return "fail";
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
export function createHoneypotCheck(
  config: AppConfig,
  fetcher: typeof fetch = fetch,
): (mint: string) => Promise<{ ok: boolean; reason: string | null }> {
  const connection = new Connection(config.rugCheckRpcUrl, {
    commitment: "processed",
    fetch: fetcher,
    disableRetryOnRateLimit: true,
  });
  return async (mint: string) => {
    try {
      return honeypotDecision(await simulateTinySell(connection, config, mint));
    } catch {
      return honeypotDecision("unsimulated");
    }
  };
}

async function simulateTinySell(connection: Connection, config: AppConfig, mint: string): Promise<SellSim> {
  const origin = new URL(config.tradeApiUrl).origin;
  const response = await fetch(`${origin}/api/trade-local`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: SIM_PAYER,
      action: "sell",
      mint,
      amount: 1,
      denominatedInSol: "false",
      slippage: config.sellSlippagePct,
      pool: "pump-amm",
    }),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok && bytes.length === 0) return "unsimulated";
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch {
    const text = Buffer.from(bytes).toString("utf8");
    if (/balance|token account|no record/i.test(text)) return "no-balance";
    try {
      tx = VersionedTransaction.deserialize(parseBundleTransaction(JSON.parse(text)));
    } catch {
      return "unsimulated";
    }
  }
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
  });
  return classifySellSimulation(sim.value.err, sim.value.logs);
}
