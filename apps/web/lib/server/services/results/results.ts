import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ResultModel,
  ResultSummary,
  RoundResult,
  RoundStatus,
} from "@ai-showdown/shared";
import { InternalError, NotFoundError } from "@/lib/server/errors/app-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getBriefById } from "@/lib/server/services/briefs/briefs";
import { getRenderedArtifact } from "@/lib/server/services/evaluation/artifacts";
import { getRoundOutcome } from "@/lib/server/services/evaluation/outcomes-persist";
import { joinChunks } from "@/lib/server/services/evaluation/source-assembly";
import { isRevealed } from "@/lib/server/services/pipeline/live-progress";
import {
  listChunks,
  listJudgeVerdicts,
  type StoredJudgeVerdict,
} from "@/lib/server/services/pipeline/pipeline-persist";
import { getPoolView } from "@/lib/server/services/wagering/pool";
import { getCrowdVote } from "@/lib/server/services/scoring/votes";
import { computePoolOdds } from "@/lib/odds";
import { resolveDisplayState } from "@/lib/server/services/results/display";

/**
 * The results reads (F19).
 *
 * Everything here is composition, not re-derivation: the outcome is whatever
 * F15 recorded, the verdicts are whatever F31 stored, the stakes are whatever
 * F18 settled, and the artifacts are the same frames the judge saw. This module
 * exists so the list and detail pages share one honest read rather than each
 * re-querying and drifting.
 *
 * Secondary reads degrade: a missing verdict or artifact becomes an empty value
 * the UI explains, never a thrown error that blanks the page. The one thing
 * that must not be lenient is the two-clocks rule — model code and frames are
 * only ever returned once the round is past OPEN.
 */

/** Rounds a results list shows: settled, voided, or archived after either. */
const DISPLAYABLE_STATUSES = ["SETTLED", "VOIDED", "ARCHIVED"] as const;

export interface ListResultsOptions {
  limit?: number;
}

export async function listSettledRounds(
  supabase: SupabaseClient = getServiceRoleSupabase(),
  options: ListResultsOptions = {},
): Promise<ResultSummary[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const { data, error } = await supabase
    .from("rounds")
    .select(
      "id, slug, status, settled_at, updated_at, challenges(title), round_outcomes(kind, winner_model_id, fan_favorite_model_id, tie_break, reason, all_forfeited, created_at)",
    )
    .in("status", DISPLAYABLE_STATUSES as unknown as string[])
    .order("settled_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new InternalError("Failed to read settled rounds", error);
  }

  // A voided round has no `settled_at`, so ordering by it alone buries voids.
  // Re-sort by the honest settlement moment (settled_at → outcome time →
  // updated_at) so a void appears where it actually happened.
  const rows = ((data ?? []) as RoundSummaryRow[]).sort(
    (a, b) => settledMoment(b) - settledMoment(a),
  );

  // Resolve model names in one pass rather than a query per row.
  const modelIds = new Set<string>();
  for (const row of rows) {
    const outcome = single(row.round_outcomes);
    if (outcome?.winner_model_id) modelIds.add(outcome.winner_model_id);
    if (outcome?.fan_favorite_model_id)
      modelIds.add(outcome.fan_favorite_model_id);
  }
  const names = await readModelNames([...modelIds], supabase);

  return Promise.all(
    rows.map(async (row): Promise<ResultSummary> => {
      const challenge = single(row.challenges);
      const outcome = single(row.round_outcomes);
      const { potSol } = await readSolPool(row.id, supabase);

      if (!outcome) {
        // A CANCELLED/FAILED round that reached a displayable status without an
        // outcome row: report it as a void with no winner.
        return {
          roundId: row.id,
          slug: row.slug,
          briefTitle: challenge?.title ?? row.slug,
          kind: "voided",
          displayState: resolveDisplayState({
            status: row.status,
            outcome: null,
            modelStatuses: [],
          }),
          conformedModel: null,
          crowdModel: null,
          poolSol: potSol,
          reason: "This round did not produce a result.",
          settledAt: row.settled_at ?? row.updated_at,
        };
      }

      // A voided round has no `settled_at` (transition_round stamps it only on
      // SETTLED), so the outcome's write time is the honest settlement moment.
      const settledAt = row.settled_at ?? outcome.created_at ?? row.updated_at;

      return {
        roundId: row.id,
        slug: row.slug,
        briefTitle: challenge?.title ?? row.slug,
        kind: outcome.kind,
        displayState: resolveDisplayState({
          status: row.status,
          outcome: {
            kind: outcome.kind,
            winnerModelId: outcome.winner_model_id,
            tieBreak: outcome.tie_break,
            allForfeited: outcome.all_forfeited,
          },
          modelStatuses: [],
        }),
        conformedModel: outcome.winner_model_id
          ? (names.get(outcome.winner_model_id) ?? null)
          : null,
        crowdModel: outcome.fan_favorite_model_id
          ? (names.get(outcome.fan_favorite_model_id) ?? null)
          : null,
        poolSol: potSol,
        reason: outcome.reason,
        settledAt,
      };
    }),
  );
}

/**
 * One round's full result, for the detail + replay page.
 *
 * `viewerId`, when present, is used only to attach the caller's own stake —
 * never anyone else's. Reads run with the service role because the pool totals
 * and other accounts' stakes are not grant-readable, and the aggregates are
 * public competition data.
 */
export async function getRoundResult(
  roundId: string,
  viewerId: string | null,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<RoundResult> {
  const { data: roundData, error: roundError } = await supabase
    .from("rounds")
    .select(
      "id, slug, status, challenge_id, prediction_deadline, settled_at, round_models(ordinal, llm_models(id, name))",
    )
    .eq("id", roundId)
    .maybeSingle();

  if (roundError) {
    throw new InternalError("Failed to read the round", roundError);
  }
  if (!roundData) {
    throw new NotFoundError(`Round ${roundId} does not exist`);
  }

  const round = roundData as RoundDetailRow;
  const revealed = isRevealed(round.status as RoundStatus);

  const [brief, outcome, verdicts, stakeSummary, crowd] = await Promise.all([
    getBriefById(round.challenge_id, supabase),
    getRoundOutcome(roundId, supabase),
    listJudgeVerdicts(roundId, supabase),
    readSolPool(roundId, supabase),
    getCrowdVote(roundId, supabase),
  ]);

  const participants = (round.round_models ?? [])
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .flatMap((row) => {
      const model = Array.isArray(row.llm_models)
        ? row.llm_models[0]
        : row.llm_models;
      return model
        ? [{ modelId: model.id, name: model.name, ordinal: row.ordinal }]
        : [];
    });

  const verdictByModel = new Map<string, StoredJudgeVerdict>();
  for (const verdict of verdicts) {
    verdictByModel.set(verdict.subjectModelId, verdict);
  }

  const odds = computePoolOdds({
    models: participants.map((p) => ({ id: p.modelId, name: p.name })),
    stakesByModel: stakeSummary.lamportsByModel,
  });
  const oddsByModel = new Map(odds.models.map((o) => [o.modelId, o]));

  // The per-model recorded status, so the display resolver and the model rows
  // agree. Absent outcome results fall back to the judge verdict / gate.
  const recordedByModel = new Map(
    (outcome?.results ?? []).map((r) => [r.modelId, r]),
  );

  const models: ResultModel[] = await Promise.all(
    participants.map(async (participant) => {
      // Two clocks: nothing judgemental or renderable is exposed before the
      // round locks, even though the service role could read it (R7).
      const verdict = revealed
        ? (verdictByModel.get(participant.modelId) ?? null)
        : null;
      const recorded = recordedByModel.get(participant.modelId);

      const artifact = revealed
        ? await readModelArtifact(roundId, participant.modelId, supabase)
        : null;
      const solutionCode = revealed
        ? await readModelSource(roundId, participant.modelId, supabase)
        : null;

      const status =
        recorded?.status ??
        (verdict
          ? verdict.verdict
          : artifact && !artifact.gatePassed
            ? "forfeited"
            : "pending");

      const modelOdds = oddsByModel.get(participant.modelId);

      return {
        modelId: participant.modelId,
        name: participant.name,
        ordinal: participant.ordinal,
        status,
        forfeitReason:
          status === "forfeited"
            ? (artifact?.gateFailureReason ??
              recorded?.reason ??
              "It did not pass the deterministic checks.")
            : null,
        gate: artifact
          ? {
              passed: artifact.gatePassed,
              failureReason: artifact.gateFailureReason,
              checks: artifact.checks.map((check) => ({
                kind: check.kind,
                passed: check.passed,
                reason: check.reason,
              })),
            }
          : null,
        judge: verdict
          ? {
              verdict: verdict.verdict,
              reason: verdict.reason,
              criteria: verdict.criteria,
            }
          : null,
        frames: artifact?.frames ?? [],
        solutionCode,
        staked: (modelOdds?.staked ?? 0) / LAMPORTS_PER_SOL,
        multiplier: modelOdds?.multiplier ?? null,
        share: modelOdds?.share ?? 0,
        isWinner: outcome?.winnerModelId === participant.modelId,
        isFanFavorite: outcome?.fanFavoriteModelId === participant.modelId,
      };
    }),
  );

  const displayState = resolveDisplayState({
    status: round.status,
    outcome: outcome
      ? {
          kind: outcome.kind,
          winnerModelId: outcome.winnerModelId,
          tieBreak: outcome.tieBreak,
          allForfeited: outcome.allForfeited,
        }
      : null,
    modelStatuses: models.map((m) => m.status),
  });

  const viewerStake = viewerId
    ? await readViewerStake(roundId, viewerId, supabase)
    : null;

  return {
    roundId: round.id,
    slug: round.slug,
    briefTitle: brief?.title ?? round.slug,
    briefPrompt: brief?.prompt ?? "",
    status: round.status,
    revealed,
    displayState,
    replay: {
      entryPoint: brief?.entryPoint ?? "drawFrame",
      frameWidth: brief?.frameWidth ?? 640,
      frameHeight: brief?.frameHeight ?? 480,
      targetDurationMs: brief?.targetDurationMs ?? 4000,
      frameCount: brief?.frameCount ?? 24,
    },
    outcome: outcome
      ? {
          kind: outcome.kind,
          winnerModelId: outcome.winnerModelId,
          fanFavoriteModelId: outcome.fanFavoriteModelId,
          tieBreak: asTieBreak(outcome.tieBreak),
          reason: outcome.reason,
          allForfeited: outcome.allForfeited,
        }
      : null,
    pool: {
      potSol: stakeSummary.potSol,
      models: odds.models.map((model) => ({
        modelId: model.modelId,
        name: model.modelName,
        staked: model.staked / LAMPORTS_PER_SOL,
        multiplier: model.multiplier,
        share: model.share,
      })),
    },
    crowd: crowd ? { counts: crowd.tally.counts } : null,
    models,
    viewerStake,
  };
}

/**
 * The generation execution's artifact, or null.
 *
 * Mirrors settlement's `findArtifact`: a round has one generation attempt per
 * model at attempt 1, and its `rendered_artifacts` row is the frame set the judge
 * saw. Reading by (round, model, run_type, attempt) avoids a join graph.
 */
async function readModelArtifact(
  roundId: string,
  modelId: string,
  supabase: SupabaseClient,
) {
  const executionId = await findGenerationExecutionId(
    roundId,
    modelId,
    supabase,
  );
  if (!executionId) return null;
  return getRenderedArtifact(executionId);
}

/**
 * The finished source for the replay: the assembled chunks, falling back to the
 * execution's stored `solution_code` (older rows, or a single-shot run).
 */
async function readModelSource(
  roundId: string,
  modelId: string,
  supabase: SupabaseClient,
): Promise<string | null> {
  const executionId = await findGenerationExecutionId(
    roundId,
    modelId,
    supabase,
  );
  if (!executionId) return null;

  const { data } = await supabase
    .from("model_executions")
    .select("solution_code")
    .eq("id", executionId)
    .maybeSingle();

  const stored = (data as { solution_code: string | null } | null)
    ?.solution_code;

  const chunks = await listChunks(executionId, supabase);
  if (chunks.length > 0) {
    const joined = joinChunks(chunks);
    if (joined.trim() !== "") return joined;
  }

  return stored ?? null;
}

async function findGenerationExecutionId(
  roundId: string,
  modelId: string,
  supabase: SupabaseClient,
): Promise<string | null> {
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
  return (data as { id: string } | null)?.id ?? null;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/** The round's Devnet SOL pool: gross SOL and lamports per model. */
async function readSolPool(
  roundId: string,
  supabase: SupabaseClient,
): Promise<{ potSol: number; lamportsByModel: Record<string, number> }> {
  const pool = await getPoolView(roundId, supabase);
  const lamportsByModel: Record<string, number> = {};
  for (const model of pool.models) {
    lamportsByModel[model.modelId] = Number(model.stakedLamports);
  }
  return {
    potSol: Number(pool.grossLamports) / LAMPORTS_PER_SOL,
    lamportsByModel,
  };
}

/**
 * The viewer's accepted wagers on this round, summed. A user can hold an ante
 * plus live wagers; the pick shown is the model carrying the most SOL.
 */
async function readViewerStake(
  roundId: string,
  viewerId: string,
  supabase: SupabaseClient,
): Promise<RoundResult["viewerStake"]> {
  const { data, error } = await supabase
    .from("wagers")
    .select("model_id, lamports, settlement_outcome, payout_lamports")
    .eq("round_id", roundId)
    .eq("user_id", viewerId)
    .eq("status", "accepted");

  if (error) {
    throw new InternalError("Failed to read your wagers", error);
  }
  const rows = (data ?? []) as Array<{
    model_id: string;
    lamports: number | string;
    settlement_outcome: string | null;
    payout_lamports: number | string | null;
  }>;
  if (rows.length === 0) return null;

  const byModel = new Map<string, number>();
  let lamports = 0;
  let payout = 0;
  let settled = true;
  let anyWon = false;
  let allRefunded = true;
  for (const row of rows) {
    const amount = Number(row.lamports);
    lamports += amount;
    byModel.set(row.model_id, (byModel.get(row.model_id) ?? 0) + amount);
    if (row.settlement_outcome === null) settled = false;
    if (row.settlement_outcome === "won") anyWon = true;
    if (row.settlement_outcome !== "refunded") allRefunded = false;
    payout += Number(row.payout_lamports ?? 0);
  }
  const modelId = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0][0];

  return {
    modelId,
    amountSol: lamports / LAMPORTS_PER_SOL,
    outcome: !settled ? null : allRefunded ? "void" : anyWon ? "won" : "lost",
    payoutSol: settled ? payout / LAMPORTS_PER_SOL : null,
  };
}

async function readModelNames(
  modelIds: readonly string[],
  supabase: SupabaseClient,
): Promise<Map<string, string>> {
  if (modelIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("llm_models")
    .select("id, name")
    .in("id", modelIds as string[]);

  if (error) {
    throw new InternalError("Failed to read model names", error);
  }

  return new Map(
    ((data ?? []) as Array<{ id: string; name: string }>).map((row) => [
      row.id,
      row.name,
    ]),
  );
}

interface OutcomeRow {
  kind: "settled" | "voided";
  winner_model_id: string | null;
  fan_favorite_model_id: string | null;
  tie_break: string | null;
  reason: string;
  all_forfeited: boolean;
  /** Present on the list query; the truthful timestamp for a voided round. */
  created_at?: string;
}

interface RoundSummaryRow {
  id: string;
  slug: string;
  status: string;
  settled_at: string | null;
  updated_at: string;
  challenges: { title: string } | Array<{ title: string }> | null;
  round_outcomes: OutcomeRow | OutcomeRow[] | null;
}

interface RoundDetailRow {
  id: string;
  slug: string;
  status: string;
  challenge_id: string;
  prediction_deadline: string;
  settled_at: string | null;
  round_models: Array<{
    ordinal: number;
    llm_models:
      { id: string; name: string } | Array<{ id: string; name: string }>;
  }> | null;
}

/** Supabase returns a to-one relation as an object or a one-element array. */
function single<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

/** Milliseconds since epoch for a summary row's settlement moment, for sorting. */
function settledMoment(row: RoundSummaryRow): number {
  const outcome = single(row.round_outcomes);
  const iso = row.settled_at ?? outcome?.created_at ?? row.updated_at;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Narrow the stored `tie_break` text to the type the contract exposes. */
function asTieBreak(
  value: string | null,
): "sole-conformer" | "crowd-vote" | "stable-order" | null {
  return value === "sole-conformer" ||
    value === "crowd-vote" ||
    value === "stable-order"
    ? value
    : null;
}
