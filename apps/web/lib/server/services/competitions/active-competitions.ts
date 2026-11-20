import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { computePoolOdds, type ModelOdds } from "@/lib/odds";
import { getRoundStakeSummary } from "@/lib/server/services/scoring/stakes";

/**
 * The dashboard / round-list feed (F9).
 *
 * "Open rounds" means *actionable* rounds: `OPEN` in the lifecycle **and** inside
 * its staking window by the clock. Status alone is not enough — F11 can be late
 * to lock a round, and an `OPEN` round past its `prediction_deadline` must not be
 * offered as joinable. Eligibility is decided server-side so the list cannot
 * disagree with what `place_stake` would accept.
 */

/**
 * A soft ceiling for the pool meter. There is no stake cap in the data model,
 * so this is a display scale rather than an enforced limit; the meter clamps and
 * the capacity is raised to the pot when a round outgrows it.
 */
export const DEFAULT_POOL_CAPACITY = 5000;

export interface ActiveCompetition {
  id: string;
  title: string;
  challengePreview: string;
  models: string[];
  deadline: string;
  status: "OPEN";
  /** The live pot: every conformance stake on the round so far (F18). */
  potentialPoints: number;
  /** Display scale for the pot meter; never below the pot. */
  poolCapacity: number;
  /** Per-model standings, for live odds (F9). */
  odds: ModelOdds[];
}

export function isActiveCompetition(
  round: {
    status: string;
    prediction_opens_at: string | null;
    prediction_deadline: string;
  },
  now: Date = new Date(),
): boolean {
  if (round.status !== "OPEN") {
    return false;
  }

  const deadline = new Date(round.prediction_deadline);
  if (Number.isNaN(deadline.getTime()) || deadline <= now) {
    return false;
  }

  if (round.prediction_opens_at) {
    const opensAt = new Date(round.prediction_opens_at);
    if (Number.isNaN(opensAt.getTime()) || opensAt > now) {
      return false;
    }
  }

  return true;
}

interface RoundRow {
  id: string;
  slug: string;
  status: string;
  prediction_opens_at: string | null;
  prediction_deadline: string;
  challenges:
    | { title: string; prompt: string }
    | Array<{ title: string; prompt: string }>
    | null;
  round_models: Array<{
    ordinal: number;
    llm_models:
      { id: string; name: string } | Array<{ id: string; name: string }>;
  }> | null;
}

export async function getActiveCompetitions(
  supabase: SupabaseClient,
): Promise<ActiveCompetition[]> {
  const { data, error } = await supabase
    .from("rounds")
    .select(
      "id, slug, status, prediction_opens_at, prediction_deadline, challenges(title, prompt), round_models(ordinal, llm_models(id, name))",
    )
    .eq("status", "OPEN")
    .order("prediction_deadline");

  if (error) {
    throw error;
  }

  const now = new Date();
  const active = ((data ?? []) as RoundRow[]).filter((competition) =>
    isActiveCompetition(competition, now),
  );

  // The pot and the per-model split are both sums over other accounts' stakes,
  // which a viewer holds no grant to read (own-rows-only RLS). Stakes are public
  // competition data; the rows are not. Reading them with the service role to
  // publish the aggregate keeps the pool honest without exposing who backed what.
  const entries = await Promise.all(
    active.map(async (competition) => {
      const challenge = Array.isArray(competition.challenges)
        ? competition.challenges[0]
        : competition.challenges;

      const models = (competition.round_models ?? [])
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal)
        .flatMap((roundModel) =>
          Array.isArray(roundModel.llm_models)
            ? roundModel.llm_models
            : [roundModel.llm_models],
        )
        .filter((model): model is { id: string; name: string } =>
          Boolean(model?.id),
        )
        .map((model) => ({ id: model.id, name: model.name }));

      const summary = await getRoundStakeSummary(competition.id, supabase);
      const odds = computePoolOdds({
        models,
        stakesByModel: summary.stakesByModel,
      });

      const entry: ActiveCompetition = {
        id: competition.id,
        title: challenge?.title ?? competition.slug,
        challengePreview: challenge?.prompt ?? "",
        models: models.map((model) => model.name),
        deadline: competition.prediction_deadline,
        status: "OPEN",
        potentialPoints: odds.pot,
        poolCapacity: Math.max(DEFAULT_POOL_CAPACITY, odds.pot),
        odds: odds.models,
      };

      return entry;
    }),
  );

  return entries;
}

// ---------------------------------------------------------------------------
// Live rounds (F27)
// ---------------------------------------------------------------------------

/** Statuses a round is *happening* in — the ones worth watching right now. */
const LIVE_STATUSES = ["RUNNING", "EVALUATING", "RETRYING"] as const;

export type LiveRoundStatus = (typeof LIVE_STATUSES)[number];

/** One round currently in progress, for the "Live now" strip. */
export interface LiveCompetition {
  id: string;
  title: string;
  status: LiveRoundStatus;
  models: Array<{ id: string; name: string }>;
  /** How many models are done, judged or otherwise, out of the lineup. */
  progress: { done: number; total: number };
}

/**
 * Rounds that are running or being judged right now.
 *
 * Deliberately not "recently settled": the strip is a live indicator, and a
 * finished round belongs in Results. `progress` counts models that have reached
 * a resting state (a ruling, a forfeit, or an outage), which is the honest
 * "how far along is this" without claiming a percentage of unknown work.
 *
 * Rounds are never fabricated: an empty list means the strip does not render.
 */
export async function getLiveCompetitions(
  supabase: SupabaseClient,
): Promise<LiveCompetition[]> {
  const { data, error } = await supabase
    .from("rounds")
    .select(
      "id, slug, status, challenges(title), round_models(ordinal, llm_models(id, name))",
    )
    .in("status", LIVE_STATUSES as unknown as string[])
    .order("started_at", { ascending: false, nullsFirst: false });

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as Array<{
    id: string;
    slug: string;
    status: string;
    challenges: { title: string } | Array<{ title: string }> | null;
    round_models: Array<{
      ordinal: number;
      llm_models:
        { id: string; name: string } | Array<{ id: string; name: string }>;
    }> | null;
  }>;

  if (rows.length === 0) return [];

  // One read for every round's per-model resting state, rather than a query per
  // model. A generation execution that is no longer `pending`/`running` is done,
  // and a stored judge verdict also counts as done.
  const roundIds = rows.map((row) => row.id);

  const [{ data: executionRows }, { data: verdictRows }] = await Promise.all([
    supabase
      .from("model_executions")
      .select("round_id, model_id, status")
      .in("round_id", roundIds)
      .eq("run_type", "generation"),
    supabase
      .from("judge_verdicts")
      .select("round_id, subject_model_id")
      .in("round_id", roundIds),
  ]);

  const doneByRound = new Map<string, Set<string>>();
  for (const execution of (executionRows ?? []) as Array<{
    round_id: string;
    model_id: string;
    status: string;
  }>) {
    if (execution.status === "pending" || execution.status === "running") {
      continue;
    }
    const done = doneByRound.get(execution.round_id) ?? new Set<string>();
    done.add(execution.model_id);
    doneByRound.set(execution.round_id, done);
  }
  for (const verdict of (verdictRows ?? []) as Array<{
    round_id: string;
    subject_model_id: string;
  }>) {
    const done = doneByRound.get(verdict.round_id) ?? new Set<string>();
    done.add(verdict.subject_model_id);
    doneByRound.set(verdict.round_id, done);
  }

  return rows.map((row) => {
    const challenge = Array.isArray(row.challenges)
      ? row.challenges[0]
      : row.challenges;

    const models = (row.round_models ?? [])
      .slice()
      .sort((a, b) => a.ordinal - b.ordinal)
      .flatMap((roundModel) =>
        Array.isArray(roundModel.llm_models)
          ? roundModel.llm_models
          : [roundModel.llm_models],
      )
      .filter((model): model is { id: string; name: string } =>
        Boolean(model?.id),
      )
      .map((model) => ({ id: model.id, name: model.name }));

    const done = doneByRound.get(row.id) ?? new Set<string>();

    return {
      id: row.id,
      title: challenge?.title ?? row.slug,
      status: row.status as LiveRoundStatus,
      models,
      progress: {
        done: models.filter((model) => done.has(model.id)).length,
        total: models.length,
      },
    };
  });
}
