import { PublicKey } from "@solana/web3.js";
import { excludedHolderAccounts, protocolHolders, readLargestAccounts, readSupplyAmount, top10SharePct } from "../holders.js";
import { inspectMintAccount } from "../safety.js";
import { BURN_OWNERS } from "./rules.js";

export interface ChainFacts {
  mintOk: boolean;
  mintReason: string | null;
  top10Pct: number | null;
  devPct: number | null;
}

interface RpcEnvelope {
  result?: unknown;
  error?: { message?: string };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

async function rpc(url: string, fetcher: typeof fetch, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`rpc HTTP ${response.status}`);
  const payload = (await response.json()) as RpcEnvelope;
  if (payload.error) throw new Error(payload.error.message ?? "rpc error");
  return payload.result;
}

/**
 * Mint authorities, transfer fee, top-10, and dev share.
 * Reads `RUG_CHECK_RPC_URL`. A miss fails closed in the safety rules.
 * Top-10 drops the pool, LP, protocol, and burn accounts.
 */
export async function readChainFacts(
  rpcUrl: string,
  mint: string,
  creator: string | null,
  fetcher: typeof fetch = fetch,
): Promise<ChainFacts> {
  const unavailable = { mintOk: false, mintReason: "mint_unavailable", top10Pct: null, devPct: null };
  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return { ...unavailable, mintReason: "mint_invalid" };
  }
  try {
    const info = asRecord(
      asRecord(await rpc(rpcUrl, fetcher, "getAccountInfo", [mint, { encoding: "base64", commitment: "processed" }]))?.value,
    );
    const owner = typeof info?.owner === "string" ? info.owner : "";
    const dataField = info?.data;
    const encoded = Array.isArray(dataField) && typeof dataField[0] === "string" ? dataField[0] : null;
    if (!encoded) return unavailable;
    const inspected = inspectMintAccount(owner, Buffer.from(encoded, "base64"));
    const protocol = protocolHolders(mintKey);
    const exclude = new Set([...excludedHolderAccounts(mintKey), ...BURN_OWNERS]);
    const owners = new Set([...protocol.owners, ...BURN_OWNERS]);
    const largest = readLargestAccounts(
      await rpc(rpcUrl, fetcher, "getTokenLargestAccounts", [mint, { commitment: "processed" }]),
    );
    const supply = readSupplyAmount(
      await rpc(rpcUrl, fetcher, "getTokenSupply", [mint, { commitment: "processed" }]),
    );
    const accountOwners = await readOwners(rpcUrl, fetcher, largest.map((row) => row.address));
    const top10Pct =
      supply == null ? null : top10SharePct(largest, supply, exclude, accountOwners, owners);
    let devPct: number | null = null;
    if (creator && supply != null && supply > 0n) {
      let held = 0n;
      for (const row of largest) {
        if (accountOwners.get(row.address) === creator) held += row.amount;
      }
      devPct = Number((held * 1_000_000n) / supply) / 10_000;
    }
    return { mintOk: inspected.ok, mintReason: inspected.reason, top10Pct, devPct };
  } catch {
    return unavailable;
  }
}

async function readOwners(url: string, fetcher: typeof fetch, addresses: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (addresses.length === 0) return map;
  const result = asRecord(
    await rpc(url, fetcher, "getMultipleAccounts", [addresses, { encoding: "jsonParsed", commitment: "processed" }]),
  );
  const value = result && Array.isArray(result.value) ? result.value : [];
  value.forEach((item, index) => {
    const address = addresses[index];
    const info = asRecord(asRecord(asRecord(asRecord(item)?.data)?.parsed)?.info);
    const owner = info?.owner;
    if (address && typeof owner === "string") map.set(address, owner);
  });
  return map;
}
