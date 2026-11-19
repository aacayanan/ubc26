import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoundStatus } from "@ai-showdown/shared";
import {
  ConflictError,
  InternalError,
  NotFoundError,
} from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getRenderedArtifact } from "@/lib/server/services/evaluation/artifacts";
import {
  classifyModelOutcome,
  resolveRoundOutcome,
  type ModelOutcomeInput,
  type RoundResolution,
} from "@/lib/server/services/evaluation/outcome";
import { getRoundOutcome } from "@/lib/server/services/evaluation/outcomes-persist";
import { listJudgeVerdicts } from "@/lib/server/services/pipeline/pipeline-persist";
import { loadRoundRunInputs } from "@/lib/server/services/pipeline/round-inputs";
import {
  computeFanFavoriteAwards,
  computeParimutuelPayouts,
  type PoolStake,
  type RoundKind,
} from "@/lib/server/services/scoring/parimutuel";
import { getCrowdVote } from "@/lib/server/services/scoring/votes";

/**
 * Resolve a round exactly once (F18).
 *
 * The pipeline (F17) deliberately stops at `EVALUATING` — every verdict the
 * round can have is in, and deciding what that means is this module's job. It
 * reuses the F15 rules rather than restating them: `classifyModelOutcome` turns
 * the stored gate and the stored ruling into a conformance, and
 * `resolveRoundOutcome` turns those (plus the crowd vote) into exactly one
 * resolution. This module adds only what F15 left out — the pot.
 *
 * Order of operations is load-bearing and ends in a single RPC:
 *
 *   read verdicts → resolve → compute payouts → `settle_round` (one transaction)
 *
 * Everything the database must keep true at once — every stake settled, one
 * score event per user per kind, balances credited, `round_outcomes` written,
 * status moved to SETTLED/VOIDED — happens inside `public.settle_round`, so an
 * interrupted run leaves either all of it or none of it. A second call for an
 * already-final round is a no-op that returns what was recorded, which is what
 * makes a retried job safe.
 *
 * A round that cannot be decided (`incomplete` or `retryable`) writes nothing:
 * settling on a guess is what F15 forbids, and a judge outage must be retried
 * rather than converted into a payout.
 */

const SETTLEABLE: RoundStatus = "EVALUATING";
const FINAL_STATUSES: readonly RoundStatus[] = [
  "SETTLED",
  "VOIDED",
  "ARCHIVED",
];

export interface SettleRoundInput {
  roundId: string;
  correlationId: string;
  supabase?: SupabaseClient;
}

export interface SettleRoundResult {
  roundId: string;
  slug: string;
  /** What settlement decided, or the reason it decided nothing yet. */
  status: "settled" | "voided" | "already-final" | "incomplete" | "retryable";
  reason: string;
  potPoints: number;
  winnerModelId: string | null;
  fanFavoriteModelId: string | null;
  /** How many stakes were settled (0 when nothing was written). */
  stakesSettled: number;
  /** Points credited in total (pool returns + fan-favorite awards). */
  pointsCredited: number;
}

export async function settleRound(
  input: SettleRoundInput,
): Promise<SettleRoundResult> {
  const { roundId, correlationId } = input;
  const supabase = input.supabase ?? getServiceRoleSupabase();

  const { data: roundData, error: roundError } = await supabase
    .from("rounds")
    .select("id, slug, status")
    .eq("id", roundId)
    .maybeSingle();

  if (roundError) {
    throw new InternalError("Failed to read the round", roundError);
  }
  if (!roundData) {
    throw new NotFoundError(`Round ${roundId} does not exist`);
  }

  const round = roundData as { id: string; slug: string; status: RoundStatus };

  // A finalized round is not re-settled — report what is already recorded so a
  // repeated job is idempotent all the way up, not just inside the RPC.
  if (FINAL_STATUSES.includes(round.status)) {
    return alreadyFinal(round, supabase);
  }

  if (round.status !== SETTLEABLE) {
    throw new ConflictError(
      `Round ${round.slug} is ${round.status}; settlement only runs on an EVALUATING round`,
    );
  }

  const inputs = await loadRoundRunInputs(roundId, supabase);
  const verdicts = await listJudgeVerdicts(roundId, supabase);
  const verdictByModel = new Map(verdicts.map((v) => [v.subjectModelId, v]));

  const models: ModelOutcomeInput[] = [];

  for (const participant of inputs.participants) {
    const artifact = await findArtifact(roundId, participant.id, supabase);
    const stored = verdictByModel.get(participant.id) ?? null;

    // No artifact and no source means the pipeline never reached this model, or
    // it forfeited during generation. Both read through the gate as a forfeit.
    const gate = artifact
      ? {
          passed: artifact.gatePassed,
          unavailable: artifact.unavailable,
          failureReason: artifact.gateFailureReason,
        }
      : {
          passed: false,
          unavailable: false,
          failureReason: "The model produced no render to evaluate.",
        };

    const judge = stored
      ? {
          kind: "ruled" as const,
          conformed: stored.verdict === "conformed",
          reason: stored.reason,
        }
      : null;

    // A stored 'unavailable' ruling is a judge outage, not a ruling; F15 reads
    // it as retryable, so map it to the judge-unavailable shape rather than
    // inventing a pass or fail.
    const judgeInput =
      stored?.verdict === "unavailable"
        ? { kind: "unavailable" as const, reason: stored.reason }
        : judge;

    const classified = classifyModelOutcome({ gate, judge: judgeInput });

    models.push({
      modelId: participant.id,
      name: participant.name,
      ordinal: participant.ordinal,
      conformance: classified.conformance,
      reason: classified.reason,
    });
  }

  const { tally, votes } = await getCrowdVote(roundId, supabase);
  const resolution = resolveRoundOutcome(models, tally);

  if (resolution.kind === "incomplete" || resolution.kind === "retryable") {
    logger.info("settlement.deferred", {
      correlationId,
      roundId,
      kind: resolution.kind,
    });
    return {
      roundId,
      slug: round.slug,
      status: resolution.kind,
      reason: resolution.reason,
      potPoints: 0,
      winnerModelId: null,
      fanFavoriteModelId: null,
      stakesSettled: 0,
      pointsCredited: 0,
    };
  }

  const stakes = await loadConformanceStakes(roundId, supabase);

  // Narrow the resolution to the two decidable kinds so the winner/tiebreak
  // fields are available without a repeated discriminant check.
  const decided = resolution as Extract<
    RoundResolution,
    { kind: "settled" | "voided" }
  >;
  const kind: RoundKind = decided.kind;
  const settled = decided.kind === "settled";

  const payouts = computeParimutuelPayouts({
    stakes,
    winnerModelId: settled ? decided.winnerModelId : null,
    kind,
  });

  const awards = computeFanFavoriteAwards({
    votes,
    fanFavoriteModelId: settled ? decided.fanFavoriteModelId : null,
  });

  const { data, error } = await supabase.rpc("settle_round", {
    p_round_id: roundId,
    p_kind: kind,
    p_winner_model_id: settled ? decided.winnerModelId : null,
    p_fan_favorite_model_id: settled ? decided.fanFavoriteModelId : null,
    p_tie_break: settled ? decided.tieBreak : null,
    p_reason: decided.reason,
    p_all_forfeited:
      kind === "voided" &&
      decided.results.every((row) => row.status === "forfeited"),
    p_results: toResultPayload(decided),
    p_stakes: payouts.settlements.map((settlement) => ({
      prediction_id: settlement.predictionId,
      user_id: settlement.userId,
      outcome: settlement.outcome,
      points_awarded: settlement.pointsAwarded,
    })),
    p_awards: awards.map((award) => ({
      user_id: award.userId,
      points: award.points,
    })),
  });

  if (error) {
    throw new InternalError("Failed to settle the round", error);
  }

  const summary = (data ?? {}) as {
    alreadySettled?: boolean;
    stakesSettled?: number;
    pointsCredited?: number;
  };

  const pointsCredited =
    summary.pointsCredited ??
    payouts.settlements.reduce((sum, s) => sum + s.pointsAwarded, 0) +
      awards.reduce((sum, a) => sum + a.points, 0);

  logger.info("settlement.round.settled", {
    correlationId,
    roundId,
    kind,
    potPoints: payouts.pot,
    winnerModelId: settled ? decided.winnerModelId : null,
    fanFavoriteModelId: settled ? decided.fanFavoriteModelId : null,
    stakesSettled: summary.stakesSettled ?? payouts.settlements.length,
    alreadySettled: summary.alreadySettled === true,
  });

  return {
    roundId,
    slug: round.slug,
    status: summary.alreadySettled ? "already-final" : kind,
    reason: decided.reason,
    potPoints: payouts.pot,
    winnerModelId: settled ? decided.winnerModelId : null,
    fanFavoriteModelId: settled ? decided.fanFavoriteModelId : null,
    stakesSettled: summary.stakesSettled ?? payouts.settlements.length,
    pointsCredited,
  };
}

/**
 * The model's stored artifact.
 *
 * `rendered_artifacts` is keyed by execution id, and the generation execution id
 * is `(round, model, 'generation', 1)`. Reading by (round, model) keeps this
 * function independent of the execution id the pipeline happened to use.
 */
async function findArtifact(
  roundId: string,
  modelId: string,
  supabase: SupabaseClient,
) {
  const { data, error } = await supabase
    .from("model_executions")
    .select("id")
    .eq("round_id", roundId)
    .eq("model_id", modelId)
    .eq("run_type", "generation")
    .eq("attempt", 1)
    .maybeSingle();

  if (error) {
    throw new InternalError("Failed to read the model execution", error);
  }
  if (!data) return null;

  return getRenderedArtifact((data as { id: string }).id);
}

interface ConformanceStakeRow {
  id: string;
  user_id: string;
  model_id: string;
  stake_points: number | null;
  settled_at: string | null;
}

/**
 * Every conformance stake in the round, open or already settled.
 *
 * Already-settled rows are included on purpose: `settle_round` validates that it
 * was handed the complete set and no-ops rows that a previous interrupted attempt
 * already moved, so passing them cannot double-pay.
 */
async function loadConformanceStakes(
  roundId: string,
  supabase: SupabaseClient,
): Promise<PoolStake[]> {
  const { data, error } = await supabase
    .from("predictions")
    .select("id, user_id, model_id, stake_points, settled_at")
    .eq("round_id", roundId)
    .eq("category", "conformance");

  if (error) {
    throw new InternalError("Failed to read the round's stakes", error);
  }

  return ((data ?? []) as ConformanceStakeRow[])
    .filter((row) => row.settled_at === null)
    .map((row) => ({
      predictionId: row.id,
      userId: row.user_id,
      modelId: row.model_id,
      points: Math.max(0, row.stake_points ?? 0),
    }));
}

function toResultPayload(
  resolution: Extract<RoundResolution, { kind: "settled" | "voided" }>,
): Array<{ model_id: string; status: string; reason: string }> {
  return resolution.results.map((row) => ({
    model_id: row.modelId,
    status: row.status,
    reason: row.reason,
  }));
}

async function alreadyFinal(
  round: { id: string; slug: string; status: RoundStatus },
  supabase: SupabaseClient,
): Promise<SettleRoundResult> {
  const outcome = await getRoundOutcome(round.id, supabase);

  // Report what was actually recorded rather than zeros. `potPoints: 0` on a
  // settled round with stakes reads as "nothing was at stake", which is wrong and
  // is what a viewer sees on the first (idempotent) retry.
  const { data, error } = await supabase
    .from("predictions")
    .select("stake_points, points_awarded")
    .eq("round_id", round.id)
    .eq("category", "conformance");

  if (error) {
    throw new InternalError("Failed to read the settled stakes", error);
  }

  const rows = (data ?? []) as Array<{
    stake_points: number | null;
    points_awarded: number | null;
  }>;

  return {
    roundId: round.id,
    slug: round.slug,
    status: "already-final",
    reason:
      outcome?.reason ?? `Round ${round.slug} is already ${round.status}.`,
    potPoints: rows.reduce((sum, row) => sum + (row.stake_points ?? 0), 0),
    winnerModelId: outcome?.winnerModelId ?? null,
    fanFavoriteModelId: outcome?.fanFavoriteModelId ?? null,
    stakesSettled: rows.length,
    pointsCredited: rows.reduce(
      (sum, row) => sum + (row.points_awarded ?? 0),
      0,
    ),
  };
}

/**
 * Rounds the settlement job may pick up now.
 *
 * Only `EVALUATING`: a round still `RUNNING` has not produced every verdict yet,
 * and one already final has nothing to do. Oldest first, mirroring the pipeline's
 * resume scan, so a backlog drains in order.
 */
export async function listRoundsAwaitingSettlement(
  options: { limit?: number; supabase?: SupabaseClient } = {},
): Promise<Array<{ id: string; slug: string }>> {
  const supabase = options.supabase ?? getServiceRoleSupabase();
  const limit = options.limit ?? 20;

  const { data, error } = await supabase
    .from("rounds")
    .select("id, slug")
    .eq("status", SETTLEABLE)
    .order("started_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(limit);

  if (error) {
    throw new InternalError("Failed to list rounds awaiting settlement", error);
  }

  return (data ?? []) as Array<{ id: string; slug: string }>;
}
