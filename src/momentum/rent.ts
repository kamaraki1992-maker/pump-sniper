import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type Keypair,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../safety.js";

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** spl-token CloseAccount discriminator. Destination receives the rent. */
const CLOSE_ACCOUNT = 9;
/** Token-2022 account extension that stores withheld transfer fees. */
const TRANSFER_FEE_AMOUNT = 2;

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), program.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export function closeAccountInstruction(
  account: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  program: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([CLOSE_ACCOUNT]),
  });
}

/** Withheld transfer-fee amount. `0` when the extension is absent. `null` when the TLV is truncated. */
export function withheldTransferFee(data: Uint8Array): bigint | null {
  if (data.length <= 166) return 0n;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 166;
  while (offset + 4 <= data.length) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    if (offset + 4 + length > data.length) return null;
    if (type === TRANSFER_FEE_AMOUNT && length >= 8) return view.getBigUint64(offset + 4, true);
    offset += 4 + length;
    const pad = offset % 4;
    if (pad !== 0) offset += 4 - pad;
  }
  return 0n;
}

export function readTokenAccount(data: Uint8Array): { owner: string; amount: bigint } | null {
  if (data.length < 72) return null;
  try {
    const owner = new PublicKey(data.subarray(32, 64)).toBase58();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { owner, amount: view.getBigUint64(64, true) };
  } catch {
    return null;
  }
}

export interface RentAccount {
  program: string;
  owner: string;
  amount: bigint;
  lamports: number;
  data: Uint8Array;
}

/** Close only an empty account owned by the burner, and never one that still withholds fees. */
export function rentDecision(
  account: RentAccount,
  burner: string,
): { close: boolean; reason: string; rentSol: number } {
  if (account.owner !== burner) return { close: false, reason: "owner", rentSol: 0 };
  if (account.amount !== 0n) return { close: false, reason: "balance", rentSol: 0 };
  if (account.program === TOKEN_2022_PROGRAM_ID) {
    const withheld = withheldTransferFee(account.data);
    if (withheld == null) return { close: false, reason: "unparsed", rentSol: 0 };
    if (withheld > 0n) return { close: false, reason: "withheld_fees", rentSol: 0 };
  }
  return { close: true, reason: "empty", rentSol: account.lamports / 1e9 };
}

export interface ReclaimResult {
  closed: boolean;
  rentSol: number;
  reason: string;
  signature: string | null;
}

/**
 * Separate close transaction. Lightning builds the swap, so the close is not
 * appended to that transaction. It is sent after the sell has confirmed.
 */
export async function reclaimEmptyAta(args: {
  connection: Connection;
  owner: Keypair;
  mint: PublicKey;
  blockhash: () => Promise<string>;
  send: (tx: VersionedTransaction) => Promise<string>;
  confirm: (signature: string) => Promise<boolean>;
}): Promise<ReclaimResult> {
  const programs = [new PublicKey(TOKEN_PROGRAM_ID), new PublicKey(TOKEN_2022_PROGRAM_ID)];
  const burner = args.owner.publicKey.toBase58();
  let rentSol = 0;
  let closed = false;
  let reason = "missing";
  let signature: string | null = null;
  for (const program of programs) {
    const ata = associatedTokenAddress(args.owner.publicKey, args.mint, program);
    const info = await args.connection.getAccountInfo(ata, "confirmed");
    if (!info) continue;
    const parsed = readTokenAccount(info.data);
    if (!parsed) {
      reason = "unparsed";
      continue;
    }
    const decision = rentDecision(
      { program: program.toBase58(), owner: parsed.owner, amount: parsed.amount, lamports: info.lamports, data: info.data },
      burner,
    );
    if (!decision.close) {
      reason = decision.reason;
      continue;
    }
    const message = new TransactionMessage({
      payerKey: args.owner.publicKey,
      recentBlockhash: await args.blockhash(),
      instructions: [closeAccountInstruction(ata, args.owner.publicKey, args.owner.publicKey, program)],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([args.owner]);
    signature = await args.send(tx);
    const landed = await args.confirm(signature);
    if (!landed) return { closed: false, rentSol: 0, reason: "close_failed", signature };
    rentSol += decision.rentSol;
    closed = true;
    reason = "empty";
  }
  return { closed, rentSol, reason, signature };
}
