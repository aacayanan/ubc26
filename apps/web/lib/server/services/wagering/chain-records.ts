import "server-only";

import type { Connection } from "@solana/web3.js";
import type { TxPurpose } from "@ai-showdown/shared";
import { InternalError } from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getDevnetConnection } from "@/lib/server/integrations/solana/connection";
import { getOperatorKeypair } from "@/lib/server/integrations/solana/config";
import {
  buildOperatorMemo,
  confirmSignature,
} from "@/lib/server/integrations/solana/transactions";

/**
 * Operator-signed Memo records (F21 round + close, F22 settlement).
 *
 * These are evidence, not enforcement: the database decided first, and the memo
 * timestamps that decision publicly. A failure is a `failed` / `timeout` row,
 * never shown as confirmed, and never blocks the round.
 *
 * One record per idempotency key, and a retry can never publish a second or
 * contradictory one:
 *   - the memo text is fixed by the first attempt (stored in `payload.memo`);
 *     a retry re-sends that text, never a recomputed one;
 *   - before building a new transaction, a retry checks whether the previous
 *     signature landed (then it is simply marked confirmed) or could still land
 *     (its blockhash is not yet expired — then it waits). Only a transaction
 *     that provably can no longer land is replaced.
 */
export type OperatorRecordPurpose = Extract<
  TxPurpose,
  "round_record" | "betting_close" | "settlement"
>;

export const OPERATOR_RECORD_PURPOSES: readonly OperatorRecordPurpose[] = [
  "round_record",
  "betting_close",
  "settlement",
];

interface RecordRow {
  id: string;
  status: string;
  signature: string | null;
  payload: Record<string, unknown> | null;
  updated_at: string;
}

type PreviousAttempt =
  { kind: "landed"; slot: number } | { kind: "in_flight" } | { kind: "dead" };

/** What became of a previously sent signature. */
async function checkPreviousAttempt(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number | null,
): Promise<PreviousAttempt> {
  const { value } = await connection.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });
  const status = value[0];
  if (status) {
    if (status.err) return { kind: "dead" };
    if (
      status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized"
    ) {
      return { kind: "landed", slot: status.slot };
    }
    return { kind: "in_flight" };
  }
  // Unknown signature: it can still land until its blockhash expires. Without
  // a stored expiry, assume it might (the caller retries later).
  if (lastValidBlockHeight === null) return { kind: "in_flight" };
  const height = await connection.getBlockHeight("confirmed");
  return height > lastValidBlockHeight
    ? { kind: "dead" }
    : { kind: "in_flight" };
}

export async function recordOperatorMemo(input: {
  purpose: OperatorRecordPurpose;
  idempotencyKey: string;
  roundId: string;
  memo: string;
  payload?: Record<string, unknown>;
}): Promise<{ status: string; signature: string | null }> {
  const supabase = getServiceRoleSupabase();

  const { data: found } = await supabase
    .from("blockchain_transactions")
    .select("id, status, signature, payload, updated_at")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  let existing = (found as RecordRow | null) ?? null;
  if (existing?.status === "confirmed") {
    return { status: "confirmed", signature: existing.signature };
  }

  if (!existing) {
    const { data, error } = await supabase
      .from("blockchain_transactions")
      .insert({
        idempotency_key: input.idempotencyKey,
        purpose: input.purpose,
        status: "pending",
        round_id: input.roundId,
        payload: { memo: input.memo, ...(input.payload ?? {}) },
      })
      .select("id, status, signature, payload, updated_at")
      .single();
    if (error) {
      // Someone else is recording this key right now.
      if (error.code === "23505") return { status: "pending", signature: null };
      throw new InternalError("Failed to record the chain record", error);
    }
    existing = data as RecordRow;
  }

  const rowId = existing.id;
  const payload = existing.payload ?? {};
  // The first attempt fixed the text; a retry never publishes a different one.
  const memo = typeof payload.memo === "string" ? payload.memo : input.memo;

  try {
    const connection = await getDevnetConnection();

    if (existing.signature) {
      const previous = await checkPreviousAttempt(
        connection,
        existing.signature,
        typeof payload.lastValidBlockHeight === "number"
          ? payload.lastValidBlockHeight
          : null,
      );
      if (previous.kind === "landed") {
        await supabase
          .from("blockchain_transactions")
          .update({
            status: "confirmed",
            slot: previous.slot,
            confirmed_at: new Date().toISOString(),
            error: null,
          })
          .eq("id", rowId);
        return { status: "confirmed", signature: existing.signature };
      }
      if (previous.kind === "in_flight") {
        return { status: "pending", signature: existing.signature };
      }
    }

    const operator = getOperatorKeypair();
    const built = await buildOperatorMemo({ connection, operator, memo });

    // Claim the attempt: only one caller replaces a given signature.
    const { data: claimed } = await supabase
      .from("blockchain_transactions")
      .update({
        status: "pending",
        signature: built.signature,
        wallet_address: operator.publicKey.toBase58(),
        submitted_at: new Date().toISOString(),
        payload: {
          ...payload,
          memo,
          lastValidBlockHeight: built.lastValidBlockHeight,
        },
        error: null,
      })
      .eq("id", rowId)
      .eq("updated_at", existing.updated_at)
      .select("id");
    if (!claimed || claimed.length === 0) {
      return { status: "pending", signature: existing.signature };
    }

    await connection.sendRawTransaction(built.raw, {
      skipPreflight: false,
      maxRetries: 0,
    });
    const outcome = await confirmSignature({
      connection,
      signature: built.signature,
      lastValidBlockHeight: built.lastValidBlockHeight,
      raw: built.raw,
      timeoutMs: 30_000,
    });

    if (outcome.kind === "confirmed" && !outcome.failed) {
      await supabase
        .from("blockchain_transactions")
        .update({
          status: "confirmed",
          slot: outcome.slot,
          confirmed_at: new Date().toISOString(),
        })
        .eq("id", rowId);
      return { status: "confirmed", signature: built.signature };
    }

    const status = outcome.kind === "pending" ? "timeout" : "failed";
    await supabase
      .from("blockchain_transactions")
      .update({
        status,
        error: outcome.kind === "confirmed" ? outcome.error : outcome.kind,
      })
      .eq("id", rowId);
    return { status, signature: built.signature };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("chain.memo.failed", {
      purpose: input.purpose,
      roundId: input.roundId,
      error: message.slice(0, 200),
    });
    await supabase
      .from("blockchain_transactions")
      .update({ status: "failed", error: message.slice(0, 500) })
      .eq("id", rowId);
    return { status: "failed", signature: null };
  }
}

/** Fire and forget: a memo must never stall the round it describes. */
export function recordOperatorMemoInBackground(
  input: Parameters<typeof recordOperatorMemo>[0],
): void {
  void recordOperatorMemo(input).catch((error) => {
    logger.warn("chain.memo.background_failed", {
      purpose: input.purpose,
      error:
        error instanceof Error ? error.message.slice(0, 200) : String(error),
    });
  });
}

/**
 * Retry every operator record that is not confirmed (internal job).
 *
 * Records younger than `minAgeMs` are left alone so the job does not race the
 * request that is sending them right now. Safe to repeat: each record goes
 * through the same landed / in-flight / dead check as any retry.
 */
export async function retryOperatorRecords(input: {
  roundId?: string;
  minAgeMs?: number;
  limit?: number;
}): Promise<Record<string, number>> {
  const supabase = getServiceRoleSupabase();
  const cutoff = new Date(
    Date.now() - (input.minAgeMs ?? 60_000),
  ).toISOString();
  let query = supabase
    .from("blockchain_transactions")
    .select("idempotency_key, purpose, round_id, payload")
    .in("purpose", [...OPERATOR_RECORD_PURPOSES])
    .in("status", ["pending", "failed", "timeout"])
    .lt("updated_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(input.limit ?? 25);
  if (input.roundId) query = query.eq("round_id", input.roundId);

  const { data, error } = await query;
  if (error) throw new InternalError("Failed to list chain records", error);

  const tally: Record<string, number> = {};
  for (const row of (data ?? []) as Array<{
    idempotency_key: string;
    purpose: OperatorRecordPurpose;
    round_id: string | null;
    payload: Record<string, unknown> | null;
  }>) {
    const memo = row.payload?.memo;
    if (!row.round_id || typeof memo !== "string") {
      tally.skipped = (tally.skipped ?? 0) + 1;
      continue;
    }
    const result = await recordOperatorMemo({
      purpose: row.purpose,
      idempotencyKey: row.idempotency_key,
      roundId: row.round_id,
      memo,
    });
    tally[result.status] = (tally[result.status] ?? 0) + 1;
  }
  return tally;
}
