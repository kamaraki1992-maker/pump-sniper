import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";

export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as const;

const TIP_SET = new Set<string>(JITO_TIP_ACCOUNTS);

export function pickTipAccount(random: () => number = Math.random): PublicKey {
  const index = Math.min(JITO_TIP_ACCOUNTS.length - 1, Math.floor(random() * JITO_TIP_ACCOUNTS.length));
  return new PublicKey(JITO_TIP_ACCOUNTS[index] ?? JITO_TIP_ACCOUNTS[0]);
}

export function tipLamports(tipSol: number): number {
  return Math.round(tipSol * 1e9);
}

/** Pad the simulated unit count, then clamp to a range Solana will accept. */
export function cuLimitFromConsumed(units: number | null): number {
  const consumed = units && units > 0 ? units : 200_000;
  const padded = Math.ceil(consumed * 1.2) + 10_000;
  return Math.min(1_400_000, Math.max(80_000, padded));
}

/** microlamports per CU so the priority fee lands near `priorityFeeSol`. */
export function microLamportsForFee(priorityFeeSol: number, cuLimit: number): number {
  const lamports = Math.round(priorityFeeSol * 1e9);
  if (cuLimit <= 0 || lamports <= 0) return 0;
  return Math.max(1, Math.floor((lamports * 1_000_000) / cuLimit));
}

function isTipTransfer(ix: TransactionInstruction): boolean {
  if (!ix.programId.equals(SystemProgram.programId)) return false;
  const destination = ix.keys[1]?.pubkey.toBase58();
  return destination !== undefined && TIP_SET.has(destination);
}

/**
 * Drop any compute-budget or existing Jito tip instructions and prepend a
 * fresh limit, price, and tip. The tip account is a static key, not an ALT.
 */
export function withComputeBudgetAndTip(
  instructions: TransactionInstruction[],
  opts: {
    cuLimit: number;
    microLamports: number;
    tipLamports: number;
    tipAccount: PublicKey;
    payer: PublicKey;
  },
): TransactionInstruction[] {
  const kept = instructions.filter((ix) => {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) return false;
    if (isTipTransfer(ix)) return false;
    return true;
  });
  const budget = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.microLamports }),
  ];
  const tip =
    opts.tipLamports > 0
      ? [
          SystemProgram.transfer({
            fromPubkey: opts.payer,
            toPubkey: opts.tipAccount,
            lamports: opts.tipLamports,
          }),
        ]
      : [];
  return [...budget, ...tip, ...kept];
}

export function rewriteTransaction(
  tx: VersionedTransaction,
  decompiled: TransactionMessage,
  opts: {
    cuLimit: number;
    microLamports: number;
    tipLamports: number;
    tipAccount: PublicKey;
    payer: PublicKey;
    addressLookupTableAccounts: AddressLookupTableAccount[];
  },
): VersionedTransaction {
  const blockhash = tx.message.recentBlockhash;
  decompiled.instructions = withComputeBudgetAndTip(decompiled.instructions, opts);
  const message = decompiled.compileToV0Message(opts.addressLookupTableAccounts ?? []);
  message.recentBlockhash = blockhash;
  return new VersionedTransaction(message);
}
