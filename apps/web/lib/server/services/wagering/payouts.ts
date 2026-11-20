import "server-only";

import { PublicKey } from "@solana/web3.js";
import { InternalError } from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getDevnetConnection } from "@/lib/server/integrations/solana/connection";
import {
  explorerTxUrl,
  getTreasuryKeypair,
} from "@/lib/server/integrations/solana/config";
import {
  buildPayoutTransaction,
  confirmSignature,
} from "@/lib/server/integrations/solana/transactions";
import { payoutMemo } from "./commitment";

/**
 * The payout queue (F22, Devnet only): winnings and refunds as real Devnet
 * transfers from the treasury.
 *
 * Never-pay-twice rule: a payout's signature, blockhash expiry and status
 * `submitted` are written BEFORE the transaction is broadcast. A payout whose
 * outcome is unclear is `uncertain` and is only rebuilt (new blockhash, new
 * signature) once the old signature is provably dead: not found on-chain AND
 * the block height has passed its `last_valid_block_height`. A database
 * idempotency key alone would not be enough — two different signatures for the
 * same payout could both land.
 *
 * Solvency: before sending anything for a round, the treasury must cover every
 * unconfirmed payout of that round plus fees. Otherwise the round's payouts are
 * `blocked` — nobody is paid partially, and nothing is retried until an
 * operator tops the treasury up and re-queues them.
 */

const MAX_ATTEMPTS = 5;
const FEE_RESERVE_PER_PAYOUT = BigInt(20_000);

interface PayoutRow {
  id: string;
  round_id: string;
  user_id: string;
  wallet_address: string;
  kind: "winnings" | "refund";
  lamports: string | number;
  status: string;
  signature: string | null;
  last_valid_block_height: string | number | null;
  attempt: number;
}

export interface PayoutRunResult {
  confirmed: number;
  pending: number;
  failed: number;
  blocked: number;
}

export async function processPayouts(
  options: { roundId?: string; limit?: number } = {},
): Promise<PayoutRunResult> {
  const supabase = getServiceRoleSupabase();
  let query = supabase
    .from("payouts")
    .select("*")
    .or(
      `status.in.(pending,submitted,uncertain),and(status.eq.failed,attempt.lt.${MAX_ATTEMPTS})`,
    )
    .order("created_at", { ascending: true })
    .limit(options.limit ?? 25);
  if (options.roundId) query = query.eq("round_id", options.roundId);

  const { data, error } = await query;
  if (error) throw new InternalError("Failed to read the payout queue", error);
  const rows = (data ?? []) as PayoutRow[];
  const result: PayoutRunResult = {
    confirmed: 0,
    pending: 0,
    failed: 0,
    blocked: 0,
  };
  if (rows.length === 0) return result;

  const connection = await getDevnetConnection();
  const treasury = getTreasuryKeypair();

  // 1. Resolve anything already in flight before sending anything new.
  for (const row of rows.filter(
    (r) => r.status === "submitted" || r.status === "uncertain",
  )) {
    const outcome = await resolveInFlight(row, connection);
    if (outcome === "confirmed") result.confirmed += 1;
    else result.pending += 1;
  }

  // 2. Solvency per round, then send.
  const sendable = rows.filter(
    (r) =>
      (r.status === "pending" || r.status === "failed") &&
      r.attempt < MAX_ATTEMPTS,
  );
  const rounds = [...new Set(sendable.map((r) => r.round_id))];
  for (const roundId of rounds) {
    const { error: lockError } = await supabase.rpc("lock_sol_treasury");
    if (lockError)
      throw new InternalError("Failed to lock the SOL treasury", lockError);
    const balance = BigInt(
      await connection.getBalance(treasury.publicKey, "confirmed"),
    );
    const { data: owed } = await supabase
      .from("payouts")
      .select("lamports")
      .eq("round_id", roundId)
      .in("status", ["pending", "failed", "submitted", "uncertain"]);
    const liabilities = (owed ?? []).reduce(
      (sum, row) =>
        sum + BigInt(row.lamports as string | number) + FEE_RESERVE_PER_PAYOUT,
      BigInt(0),
    );
    if (balance < liabilities) {
      await supabase
        .from("payouts")
        .update({
          status: "blocked",
          last_error: `treasury holds ${balance} lamports, round owes ${liabilities}`,
        })
        .eq("round_id", roundId)
        .in("status", ["pending", "failed"]);
      logger.error("payouts.blocked_insufficient_funds", {
        roundId,
        balance: balance.toString(),
        liabilities: liabilities.toString(),
      });
      result.blocked += sendable.filter((r) => r.round_id === roundId).length;
      continue;
    }

    for (const row of sendable.filter((r) => r.round_id === roundId)) {
      const outcome = await sendPayout(row, connection, treasury);
      result[outcome] += 1;
    }
  }

  return result;
}

async function resolveInFlight(
  row: PayoutRow,
  connection: Awaited<ReturnType<typeof getDevnetConnection>>,
): Promise<"confirmed" | "pending"> {
  const supabase = getServiceRoleSupabase();
  if (!row.signature || row.last_valid_block_height === null) {
    // Claimed but never signed: nothing was broadcast.
    await supabase
      .from("payouts")
      .update({ status: "failed", last_error: "no signature recorded" })
      .eq("id", row.id)
      .eq("status", row.status)
      .eq("attempt", row.attempt)
      .is("signature", null);
    return "pending";
  }
  const outcome = await confirmSignature({
    connection,
    signature: row.signature,
    lastValidBlockHeight: Number(row.last_valid_block_height),
    timeoutMs: 3_000,
  });
  if (outcome.kind === "confirmed" && !outcome.failed) {
    await supabase
      .from("payouts")
      .update({
        status: "confirmed",
        slot: outcome.slot,
        confirmed_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", row.id)
      .eq("status", row.status)
      .eq("attempt", row.attempt)
      .eq("signature", row.signature);
    return "confirmed";
  }
  if (
    outcome.kind === "expired" ||
    (outcome.kind === "confirmed" && outcome.failed)
  ) {
    // Provably not paid: safe to rebuild with a fresh blockhash.
    await supabase
      .from("payouts")
      .update({
        status: "failed",
        last_error:
          outcome.kind === "expired"
            ? "expired before landing"
            : `failed on-chain: ${outcome.error}`,
      })
      .eq("id", row.id)
      .eq("status", row.status)
      .eq("attempt", row.attempt)
      .eq("signature", row.signature);
  }
  return "pending";
}

async function sendPayout(
  row: PayoutRow,
  connection: Awaited<ReturnType<typeof getDevnetConnection>>,
  treasury: ReturnType<typeof getTreasuryKeypair>,
): Promise<"confirmed" | "pending" | "failed"> {
  const supabase = getServiceRoleSupabase();

  let recipient: PublicKey;
  try {
    recipient = new PublicKey(row.wallet_address);
  } catch {
    await supabase
      .from("payouts")
      .update({ status: "blocked", last_error: "invalid recipient address" })
      .eq("id", row.id)
      .eq("status", row.status)
      .eq("attempt", row.attempt);
    return "failed";
  }

  const built = await buildPayoutTransaction({
    connection,
    treasury,
    recipient,
    lamports: BigInt(row.lamports),
    memo: payoutMemo(row.round_id, row.id, row.kind),
  });

  // Claim + record the signature BEFORE broadcasting (conditional on the
  // status we read, so two workers cannot both send).
  const { data: claimed, error: claimError } = await supabase
    .from("payouts")
    .update({
      status: "submitted",
      signature: built.signature,
      last_valid_block_height: built.lastValidBlockHeight,
      attempt: row.attempt + 1,
      submitted_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", row.id)
    .eq("status", row.status)
    .eq("attempt", row.attempt)
    .select("id");
  if (claimError)
    throw new InternalError("Failed to claim a payout", claimError);
  if (!claimed || claimed.length === 0) return "pending";

  try {
    await connection.sendRawTransaction(built.raw, {
      skipPreflight: false,
      maxRetries: 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/simulation failed|insufficient|blockhash not found/i.test(message)) {
      await supabase
        .from("payouts")
        .update({ status: "failed", last_error: message.slice(0, 300) })
        .eq("id", row.id)
        .eq("status", "submitted")
        .eq("attempt", row.attempt + 1)
        .eq("signature", built.signature);
      return "failed";
    }
    // Possibly forwarded: leave it submitted; the next run resolves it.
  }

  const outcome = await confirmSignature({
    connection,
    signature: built.signature,
    lastValidBlockHeight: built.lastValidBlockHeight,
    raw: built.raw,
    timeoutMs: 30_000,
  });

  if (outcome.kind === "confirmed" && !outcome.failed) {
    await supabase
      .from("payouts")
      .update({
        status: "confirmed",
        slot: outcome.slot,
        confirmed_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "submitted")
      .eq("attempt", row.attempt + 1)
      .eq("signature", built.signature);
    logger.info("payout.confirmed", {
      payoutId: row.id,
      roundId: row.round_id,
      kind: row.kind,
      explorer: explorerTxUrl(built.signature),
    });
    return "confirmed";
  }
  if (outcome.kind === "pending") {
    await supabase
      .from("payouts")
      .update({ status: "uncertain", last_error: "confirmation timed out" })
      .eq("id", row.id)
      .eq("status", "submitted")
      .eq("attempt", row.attempt + 1)
      .eq("signature", built.signature);
    return "pending";
  }
  await supabase
    .from("payouts")
    .update({
      status: "failed",
      last_error:
        outcome.kind === "expired"
          ? "expired before landing"
          : `failed on-chain: ${outcome.error}`,
    })
    .eq("id", row.id)
    .eq("status", "submitted")
    .eq("attempt", row.attempt + 1)
    .eq("signature", built.signature);
  return "failed";
}

export interface UserPayoutView {
  id: string;
  kind: string;
  lamports: string;
  status: string;
  signature: string | null;
  explorerUrl: string | null;
  lastError: string | null;
}

export async function listUserPayouts(
  userId: string,
  roundId: string,
): Promise<UserPayoutView[]> {
  const { data, error } = await getServiceRoleSupabase()
    .from("payouts")
    .select("id, kind, lamports, status, signature, last_error")
    .eq("user_id", userId)
    .eq("round_id", roundId)
    .order("created_at", { ascending: true });
  if (error) throw new InternalError("Failed to read your payouts", error);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    kind: row.kind as string,
    lamports: String(row.lamports),
    status: row.status as string,
    signature: (row.signature as string | null) ?? null,
    // Only a confirmed payout gets an explorer link presented as "paid".
    explorerUrl:
      row.status === "confirmed" && row.signature
        ? explorerTxUrl(row.signature as string)
        : null,
    lastError:
      row.status === "confirmed"
        ? null
        : ((row.last_error as string | null) ?? null),
  }));
}
