import "server-only";

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
 * timestamps that decision publicly. One record per idempotency key — a retried
 * job never posts a second, possibly contradictory, record. A failure is a
 * `failed` row, never shown as confirmed, and never blocks the round.
 */
export async function recordOperatorMemo(input: {
  purpose: Extract<TxPurpose, "round_record" | "betting_close" | "settlement">;
  idempotencyKey: string;
  roundId: string;
  memo: string;
  payload?: Record<string, unknown>;
}): Promise<{ status: string; signature: string | null }> {
  const supabase = getServiceRoleSupabase();

  const { data: existing } = await supabase
    .from("blockchain_transactions")
    .select("id, status, signature")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (existing && existing.status === "confirmed") {
    return { status: "confirmed", signature: existing.signature as string };
  }

  let rowId = existing?.id as string | undefined;
  if (!rowId) {
    const { data, error } = await supabase
      .from("blockchain_transactions")
      .insert({
        idempotency_key: input.idempotencyKey,
        purpose: input.purpose,
        status: "pending",
        round_id: input.roundId,
        payload: { memo: input.memo, ...(input.payload ?? {}) },
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") return { status: "pending", signature: null };
      throw new InternalError("Failed to record the chain record", error);
    }
    rowId = data.id as string;
  }

  try {
    const connection = await getDevnetConnection();
    const operator = getOperatorKeypair();
    const built = await buildOperatorMemo({
      connection,
      operator,
      memo: input.memo,
    });

    await supabase
      .from("blockchain_transactions")
      .update({
        signature: built.signature,
        wallet_address: operator.publicKey.toBase58(),
        submitted_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", rowId);

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
