import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, InternalError } from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { settleSolPool, type SolWager } from "@/lib/sol-pool";
import { reconcileSubmittedWagers } from "./wagers";
import { settleMemo } from "./commitment";
import { recordOperatorMemoInBackground } from "./chain-records";

/**
 * SOL settlement — the ledger half (F22, Devnet prototype).
 *
 * Runs inside `settleRound` for `devnet_sol` rounds, BEFORE the existing
 * `settle_round` RPC finalizes the round. Order:
 *
 *   1. resolve any wager still confirming (a wager co-signed before the close
 *      may land after it; it counts once it lands)
 *   2. `finalize_pool` — refuses while anything is in flight, then freezes
 *   3. dead-heat split in exact lamports (`settleSolPool`), fee on winning
 *      rounds only, full refunds otherwise
 *   4. `record_sol_settlement` — write-once; queues one payout per user
 *
 * The crowd vote is NOT an input: the money follows every model that conformed.
 * Actual transfers happen in the payout queue (`payouts.ts`).
 */

export interface SolSettlementInput {
  roundId: string;
  /** Models F15 classified as `conformed`. Empty means nobody conformed. */
  conformedModelIds: string[];
  /** Fixed round order, for deterministic dead-heat remainders. */
  modelOrder: string[];
  voided: boolean;
  supabase: SupabaseClient;
}

export async function recordSolSettlement(
  input: SolSettlementInput,
): Promise<Record<string, unknown>> {
  const { roundId, supabase } = input;

  const reconcile = await reconcileSubmittedWagers(roundId);
  if (reconcile.pending > 0) {
    throw new ConflictError(
      `${reconcile.pending} wager(s) are still confirming on Devnet; settlement will retry`,
    );
  }

  const { error: poolError } = await supabase.rpc("finalize_pool", {
    p_round_id: roundId,
  });
  if (poolError)
    throw new ConflictError(
      poolError.message ?? "The pool could not be finalized",
    );

  const { data: round, error: roundError } = await supabase
    .from("rounds")
    .select("fee_bps, sol_settlement")
    .eq("id", roundId)
    .single();
  if (roundError)
    throw new InternalError("Failed to read the round", roundError);
  if (round.sol_settlement)
    return round.sol_settlement as Record<string, unknown>;

  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await supabase
      .from("wagers")
      .select("id, user_id, wallet_address, model_id, lamports")
      .eq("round_id", roundId)
      .eq("status", "accepted")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new InternalError("Failed to read accepted wagers", error);
    rows.push(...((page ?? []) as Array<Record<string, unknown>>));
    if (!page || page.length < 1000) break;
  }

  const wagers: SolWager[] = (rows ?? []).map((row) => ({
    wagerId: row.id as string,
    userId: row.user_id as string,
    walletAddress: row.wallet_address as string,
    modelId: row.model_id as string,
    lamports: BigInt(row.lamports as string | number),
  }));

  const result = settleSolPool({
    wagers,
    winnerModelIds: input.voided ? [] : input.conformedModelIds,
    modelOrder: input.modelOrder,
    feeBps: Number(round.fee_bps),
    voided: input.voided,
  });

  const { data, error: recordError } = await supabase.rpc(
    "record_sol_settlement",
    {
      p_round_id: roundId,
      p_kind: result.kind,
      p_reason: result.reason,
      p_winner_model_ids: result.winners,
      p_fee_lamports: result.fee.toString(),
      p_outcomes: result.wagerOutcomes.map((o) => ({
        wager_id: o.wagerId,
        outcome: o.outcome,
        lamports: o.lamports.toString(),
      })),
      p_payouts: result.payouts.map((p) => ({
        user_id: p.userId,
        wallet_address: p.walletAddress,
        kind: p.kind,
        lamports: p.lamports.toString(),
        wager_ids: p.wagerIds,
      })),
    },
  );
  if (recordError)
    throw new InternalError("Failed to record the SOL settlement", recordError);

  const settlement = (data ?? {}) as Record<string, unknown>;
  logger.info("sol.settlement.recorded", {
    roundId,
    kind: result.kind,
    reason: result.reason,
    gross: result.gross.toString(),
    fee: result.fee.toString(),
    payouts: result.payouts.length,
  });

  if (settlement.alreadyRecorded === false) {
    recordOperatorMemoInBackground({
      purpose: "settlement",
      idempotencyKey: `settle:${roundId}`,
      roundId,
      memo: settleMemo({
        roundId,
        kind: result.kind,
        reason: result.reason,
        winners: result.winners,
        gross: result.gross.toString(),
        fee: result.fee.toString(),
        net: result.net.toString(),
        payoutCount: result.payouts.length,
      }),
    });
  }

  return settlement;
}
