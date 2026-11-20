import "server-only";

import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
  type Keypair,
} from "@solana/web3.js";
import { ValidationError } from "@/lib/server/errors/app-error";

/**
 * Transaction shapes for the SOL wagering prototype (Devnet only).
 *
 * A wager is ONE transaction, so the transfer and its commitment are atomic:
 *
 *   [compute-unit price]  small priority fee for congested Devnet
 *   [System transfer]     user -> treasury, `lamports`
 *   [Memo v2]             "aisd:v2:wager:..." with the user listed as signer
 *
 * The operator is the fee payer (first signature, so it is also the transaction
 * id) and therefore a required signer. The user signs with Phantom; the server
 * checks the bytes, co-signs and is the only party that can broadcast.
 */

export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

/** Micro-lamports per compute unit. Tiny; Devnet congestion is rarely severe. */
const PRIORITY_MICRO_LAMPORTS = 1_000;

export function memoInstruction(
  text: string,
  signers: PublicKey[],
): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: signers.map((pubkey) => ({
      pubkey,
      isSigner: true,
      isWritable: false,
    })),
    data: Buffer.from(text, "utf8"),
  });
}

export interface PreparedTransaction {
  transaction: Transaction;
  /** base64 of the exact message bytes; the signed copy must match it. */
  messageB64: string;
  /** base64 of the unsigned transaction, for the wallet to sign. */
  transactionB64: string;
  lastValidBlockHeight: number;
}

export async function buildWagerTransaction(input: {
  connection: Connection;
  operator: PublicKey;
  user: PublicKey;
  treasury: PublicKey;
  lamports: bigint;
  memo: string;
}): Promise<PreparedTransaction> {
  const { blockhash, lastValidBlockHeight } =
    await input.connection.getLatestBlockhash("confirmed");

  const transaction = new Transaction({
    feePayer: input.operator,
    blockhash,
    lastValidBlockHeight,
  });

  transaction.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_MICRO_LAMPORTS,
    }),
    SystemProgram.transfer({
      fromPubkey: input.user,
      toPubkey: input.treasury,
      lamports: input.lamports,
    }),
    memoInstruction(input.memo, [input.user]),
  );

  const message = transaction.serializeMessage();
  return {
    transaction,
    messageB64: message.toString("base64"),
    transactionB64: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    lastValidBlockHeight,
  };
}

/**
 * Check a wallet-signed transaction against what the server prepared, then add
 * the operator signature.
 *
 * Refuses anything whose message differs by a single byte (amount, recipient,
 * memo, blockhash, instruction order) or whose user signature is missing or
 * invalid. Returns the fully signed transaction and its signature (transaction
 * id), which is computed before anything is broadcast.
 */
export function coSignVerifiedWager(input: {
  signedB64: string;
  preparedMessageB64: string;
  user: PublicKey;
  operator: Keypair;
}): { transaction: Transaction; signature: string; raw: Buffer } {
  let transaction: Transaction;
  try {
    transaction = Transaction.from(Buffer.from(input.signedB64, "base64"));
  } catch {
    throw new ValidationError("The signed transaction could not be decoded");
  }

  const message = transaction.serializeMessage().toString("base64");
  if (message !== input.preparedMessageB64) {
    throw new ValidationError(
      "The signed transaction does not match the wager that was prepared",
    );
  }

  const userSig = transaction.signatures.find((s) =>
    s.publicKey.equals(input.user),
  );
  if (!userSig?.signature) {
    throw new ValidationError(
      "The transaction is missing your wallet's signature",
    );
  }

  // Verifies every signature present (the user's); the operator's comes next.
  if (!transaction.verifySignatures(false)) {
    throw new ValidationError(
      "The wallet signature on this transaction is invalid",
    );
  }

  transaction.partialSign(input.operator);

  const feePayerSig = transaction.signatures[0]?.signature;
  if (
    !feePayerSig ||
    !transaction.signatures[0].publicKey.equals(input.operator.publicKey)
  ) {
    throw new ValidationError("The transaction fee payer is not the operator");
  }

  const raw = transaction.serialize({
    requireAllSignatures: true,
    verifySignatures: true,
  });
  return { transaction, signature: bs58.encode(feePayerSig), raw };
}

export type ConfirmOutcome =
  | { kind: "confirmed"; slot: number; failed: boolean; error: string | null }
  | { kind: "expired" }
  | { kind: "pending" };

/**
 * Wait for a signature, rebroadcasting the same signed bytes (same signature,
 * so it can only ever land once) until it confirms or its blockhash expires.
 *
 * `pending` means we gave up waiting inside this request, not that it failed —
 * the reconcile job resolves it later.
 */
export async function confirmSignature(input: {
  connection: Connection;
  signature: string;
  lastValidBlockHeight: number;
  raw?: Buffer;
  timeoutMs?: number;
}): Promise<ConfirmOutcome> {
  const { connection, signature, lastValidBlockHeight, raw } = input;
  const deadline = Date.now() + (input.timeoutMs ?? 40_000);
  let lastBroadcast = Date.now();

  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = value[0];
    if (
      status &&
      (status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized")
    ) {
      return {
        kind: "confirmed",
        slot: status.slot,
        failed: status.err !== null,
        error: status.err ? JSON.stringify(status.err) : null,
      };
    }

    if (!status) {
      const height = await connection.getBlockHeight("confirmed");
      if (height > lastValidBlockHeight) {
        // One last look: it may have landed between the two calls.
        const again = await connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        if (!again.value[0]) return { kind: "expired" };
        continue;
      }
    }

    if (raw && Date.now() - lastBroadcast > 2_000) {
      lastBroadcast = Date.now();
      await connection
        .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
        .catch(() => undefined);
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return { kind: "pending" };
}

export interface LandedTransfer {
  ok: boolean;
  reason: string | null;
  slot: number;
  blockTime: string | null;
  /** Lamports the treasury actually gained in this transaction. */
  treasuryDelta: bigint;
}

/**
 * Re-read a confirmed wager from the chain and check it is the one we prepared.
 *
 * The message bytes must match exactly, the transaction must not have failed,
 * and the treasury's balance must have grown by the wager amount. This is what
 * "the backend verified the transaction" means — not that a wallet returned a
 * signature.
 */
export async function verifyLandedWager(input: {
  connection: Connection;
  signature: string;
  preparedMessageB64: string;
  treasury: PublicKey;
  lamports: bigint;
}): Promise<LandedTransfer> {
  const tx = await input.connection.getTransaction(input.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!tx || !tx.meta) {
    return {
      ok: false,
      reason: "transaction temporarily unavailable",
      slot: 0,
      blockTime: null,
      treasuryDelta: BigInt(0),
    };
  }

  const keys = tx.transaction.message.staticAccountKeys;
  const index = keys.findIndex((key) => key.equals(input.treasury));
  const delta =
    index >= 0
      ? BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index])
      : BigInt(0);
  const blockTime = tx.blockTime
    ? new Date(tx.blockTime * 1000).toISOString()
    : null;
  const base = { slot: tx.slot, blockTime, treasuryDelta: delta };

  if (tx.meta.err) {
    return {
      ok: false,
      reason: `transaction failed: ${JSON.stringify(tx.meta.err)}`,
      ...base,
    };
  }

  const landedMessage = Buffer.from(
    tx.transaction.message.serialize(),
  ).toString("base64");
  if (landedMessage !== input.preparedMessageB64) {
    return {
      ok: false,
      reason: "landed transaction differs from the prepared one",
      ...base,
    };
  }
  if (delta !== input.lamports) {
    return {
      ok: false,
      reason: `treasury received ${delta} lamports, expected ${input.lamports}`,
      ...base,
    };
  }

  return { ok: true, reason: null, ...base };
}

/** An operator-signed memo (round open, betting close, settlement record). */
export async function buildOperatorMemo(input: {
  connection: Connection;
  operator: Keypair;
  memo: string;
}): Promise<{ raw: Buffer; signature: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } =
    await input.connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: input.operator.publicKey,
    blockhash,
    lastValidBlockHeight,
  });
  tx.add(memoInstruction(input.memo, [input.operator.publicKey]));
  tx.sign(input.operator);
  return {
    raw: tx.serialize(),
    signature: bs58.encode(tx.signatures[0].signature!),
    lastValidBlockHeight,
  };
}

/** A treasury-signed payout or refund transfer, with its memo. */
export async function buildPayoutTransaction(input: {
  connection: Connection;
  treasury: Keypair;
  recipient: PublicKey;
  lamports: bigint;
  memo: string;
}): Promise<{ raw: Buffer; signature: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } =
    await input.connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: input.treasury.publicKey,
    blockhash,
    lastValidBlockHeight,
  });
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_MICRO_LAMPORTS,
    }),
    SystemProgram.transfer({
      fromPubkey: input.treasury.publicKey,
      toPubkey: input.recipient,
      lamports: input.lamports,
    }),
    memoInstruction(input.memo, [input.treasury.publicKey]),
  );
  tx.sign(input.treasury);
  return {
    raw: tx.serialize(),
    signature: bs58.encode(tx.signatures[0].signature!),
    lastValidBlockHeight,
  };
}

export function parsePublicKey(value: string, label: string): PublicKey {
  try {
    const key = new PublicKey(value);
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error("off curve");
    return key;
  } catch {
    throw new ValidationError(`${label} is not a valid Solana wallet address`);
  }
}
