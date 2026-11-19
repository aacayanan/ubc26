import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ConflictError,
  InternalError,
  NotFoundError,
} from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import type {
  PersistedConformance,
  RoundResolution,
} from "@/lib/server/services/evaluation/outcome";

/**
 * Persisting a round's F15 outcome.
 *
 * The resolver in `outcome.ts` decides; this module writes. Two rules it keeps:
 *
 *   * **One outcome per round.** `round_outcomes` is unique on `round_id`, so
 *     re-running an interrupted settlement updates rather than duplicating —
 *     the same discipline as `model_executions` and `rendered_artifacts`.
 *   * **A void returns every stake.** Before a round is finalized, every
 *     prediction is settled (`settled_at` + `settlement_outcome`). The database
 *     guard `ensure_round_stakes_settled` refuses to finalize a round while any
 *     conformance stake is still open, so a void cannot silently keep points.
 *
 * The points math itself is F18. This module records *what happened*, not how
 * much each backer is owed: `settlement_outcome` is the classification, and the
 * integer award lands in the same update when F18 supplies it.
 */

/** The conformance category F15/F18 write. Pre-pivot categories are legacy. */
export const CONFORMANCE_CATEGORY = "conformance";

export interface RoundOutcomeWrite {
  winnerModelId: string | null;
  fanFavoriteModelId: string | null;
  tieBreak: "sole-conformer" | "crowd-vote" | "stable-order" | null;
  reason: string;
  allForfeited: boolean;
}

/**
 * Per-model rows for `competition_results`, derived from a resolved round.
 *
 * A settled round records one row per model; a void records the rows too, so
 * the reason each model forfeited survives into Results (F19). Placement is
 * left null: the post-pivot outcomes are conformance and crowd choice, not a
 * ordered ranking, and `competition_results` deliberately has no unique
 * constraint on placement so equal conformance never needs a fake order.
 */
export function toCompetitionResultRows(
  resolution: Extract<RoundResolution, { kind: "settled" | "voided" }>,
): Array<{
  modelId: string;
  status: PersistedConformance;
  reason: string;
}> {
  return resolution.results.map((row) => ({
    modelId: row.modelId,
    status: row.status,
    reason: row.reason,
  }));
}

export async function upsertCompetitionResults(
  params: {
    roundId: string;
    resolution: Extract<RoundResolution, { kind: "settled" | "voided" }>;
  },
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<{ written: number }> {
  const { roundId, resolution } = params;
  const rows = toCompetitionResultRows(resolution);

  if (rows.length === 0) return { written: 0 };

  const { error } = await supabase.from("competition_results").upsert(
    rows.map((row) => ({
      round_id: roundId,
      model_id: row.modelId,
      category: CONFORMANCE_CATEGORY,
      status: row.status,
      placement: null,
      metric_value: null,
      reason: row.reason,
    })),
    { onConflict: "round_id,model_id,category" },
  );

  if (error) {
    throw new InternalError(
      "Failed to record the round's model results",
      error,
    );
  }

  return { written: rows.length };
}

/**
 * Record the round's single outcome row.
 *
 * Shape is validated by the `round_outcomes_settled_shape` constraint: a
 * settled row must name a winner and a tiebreak; a void must name neither.
 */
export async function upsertRoundOutcome(
  params: {
    roundId: string;
    resolution: Extract<RoundResolution, { kind: "settled" | "voided" }>;
  },
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<void> {
  const { roundId, resolution } = params;

  const write: RoundOutcomeWrite =
    resolution.kind === "settled"
      ? {
          winnerModelId: resolution.winnerModelId,
          fanFavoriteModelId: resolution.fanFavoriteModelId,
          tieBreak: resolution.tieBreak,
          reason: resolution.reason,
          allForfeited: false,
        }
      : {
          winnerModelId: null,
          fanFavoriteModelId: null,
          tieBreak: null,
          reason: resolution.reason,
          allForfeited: resolution.results.every(
            (row) => row.status === "forfeited",
          ),
        };

  const { error } = await supabase.from("round_outcomes").upsert(
    {
      round_id: roundId,
      kind: resolution.kind,
      winner_model_id: write.winnerModelId,
      fan_favorite_model_id: write.fanFavoriteModelId,
      tie_break: write.tieBreak,
      reason: write.reason,
      all_forfeited: write.allForfeited,
    },
    { onConflict: "round_id" },
  );

  if (error) {
    throw new InternalError("Failed to record the round outcome", error);
  }

  logger.info("round.outcome.recorded", {
    roundId,
    kind: resolution.kind,
    winnerModelId: write.winnerModelId,
    fanFavoriteModelId: write.fanFavoriteModelId,
    tieBreak: write.tieBreak,
  });
}

export type SettlementOutcome = "won" | "lost" | "void";

export interface StakeSettlement {
  predictionId: string;
  outcome: SettlementOutcome;
  /** Points awarded by F18; 0 on a void and on a loss. */
  pointsAwarded: number;
}

/**
 * Settle every stake in a round, then assert none was missed.
 *
 * This is the step that must run *before* the round transitions to
 * SETTLED/VOIDED — the database guard exists precisely to catch the reverse
 * order. Each row records when it was resolved and how, so a void visibly
 * returns stakes instead of silently keeping them.
 *
 * Idempotent by construction: settlement writes `settled_at` only where it is
 * currently null, so a re-run cannot re-award a stake that already resolved.
 */
export async function settleRoundStakes(
  params: {
    roundId: string;
    settlements: StakeSettlement[];
  },
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<{ settled: number }> {
  const { roundId, settlements } = params;

  if (settlements.length === 0) {
    await assertNoUnsettledStakes(roundId, supabase);
    return { settled: 0 };
  }

  const settledAt = new Date().toISOString();
  let settled = 0;

  for (const settlement of settlements) {
    if (settlement.pointsAwarded < 0) {
      throw new InternalError("A stake cannot award negative points", {
        predictionId: settlement.predictionId,
      });
    }

    // `settled_at is null` in the filter is the row-level latch: a stake that
    // already resolved is left untouched, so a retried settlement never pays
    // twice.
    const { data, error } = await supabase
      .from("predictions")
      .update({
        settled_at: settledAt,
        settlement_outcome: settlement.outcome,
        points_awarded: settlement.pointsAwarded,
      })
      .eq("id", settlement.predictionId)
      .eq("round_id", roundId)
      .is("settled_at", null)
      .select("id");

    if (error) {
      throw new InternalError("Failed to settle a stake", error);
    }

    settled += Array.isArray(data) ? data.length : 0;
  }

  await assertNoUnsettledStakes(roundId, supabase);

  return { settled };
}

/**
 * Refuse to proceed while any conformance stake in the round is open.
 *
 * The database trigger enforces this on the terminal transition; checking here
 * as well means a settlement path fails before it writes a half-finished
 * outcome, with a clearer error than a constraint violation.
 */
export async function assertNoUnsettledStakes(
  roundId: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<void> {
  const { count, error } = await supabase
    .from("predictions")
    .select("id", { count: "exact", head: true })
    .eq("round_id", roundId)
    .eq("category", CONFORMANCE_CATEGORY)
    .is("settled_at", null);

  if (error) {
    throw new InternalError("Failed to check unsettled stakes", error);
  }

  if ((count ?? 0) > 0) {
    throw new ConflictError(
      `Round ${roundId} still has ${count} unsettled stake(s); settle them before finalizing`,
    );
  }
}

export interface StoredRoundOutcomeResult {
  modelId: string;
  status: PersistedConformance;
  reason: string | null;
}

/**
 * Read a round's recorded outcome and its model results.
 *
 * The Results view (F19) reads through this so it never has to re-run the
 * resolver or infer a winner from placement.
 */
export interface RoundOutcomeRecord {
  kind: "settled" | "voided";
  winnerModelId: string | null;
  fanFavoriteModelId: string | null;
  tieBreak: string | null;
  reason: string;
  allForfeited: boolean;
  results: StoredRoundOutcomeResult[];
}

export async function getRoundOutcome(
  roundId: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<RoundOutcomeRecord | null> {
  const { data, error } = await supabase
    .from("round_outcomes")
    .select(
      "kind, winner_model_id, fan_favorite_model_id, tie_break, reason, all_forfeited",
    )
    .eq("round_id", roundId)
    .maybeSingle();

  if (error) {
    throw new InternalError("Failed to read the round outcome", error);
  }

  if (!data) return null;

  const outcome = data as {
    kind: "settled" | "voided";
    winner_model_id: string | null;
    fan_favorite_model_id: string | null;
    tie_break: string | null;
    reason: string;
    all_forfeited: boolean;
  };

  const { data: resultRows, error: resultError } = await supabase
    .from("competition_results")
    .select("model_id, status, reason")
    .eq("round_id", roundId)
    .eq("category", CONFORMANCE_CATEGORY);

  if (resultError) {
    throw new InternalError("Failed to read the round results", resultError);
  }

  return {
    kind: outcome.kind,
    winnerModelId: outcome.winner_model_id,
    fanFavoriteModelId: outcome.fan_favorite_model_id,
    tieBreak: outcome.tie_break,
    reason: outcome.reason,
    allForfeited: outcome.all_forfeited,
    results: (
      (resultRows ?? []) as Array<{
        model_id: string;
        status: PersistedConformance;
        reason: string | null;
      }>
    ).map((row) => ({
      modelId: row.model_id,
      status: row.status,
      reason: row.reason,
    })),
  };
}

export async function requireRoundOutcome(
  roundId: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<RoundOutcomeRecord> {
  const outcome = await getRoundOutcome(roundId, supabase);
  if (!outcome) {
    throw new NotFoundError(`Round ${roundId} has no recorded outcome`);
  }
  return outcome;
}
