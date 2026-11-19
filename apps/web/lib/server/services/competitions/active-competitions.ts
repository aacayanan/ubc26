import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getRoundStakeSummary } from "@/lib/server/services/scoring/stakes";

export interface ActiveCompetition {
  id: string;
  title: string;
  challengePreview: string;
  models: string[];
  deadline: string;
  status: "OPEN";
  /**
   * The live pot: every conformance stake placed on the round so far (F18).
   * Read through the service role because a viewer holds no grant to total
   * other accounts' stakes, and shown on the round card so the pool is real
   * before it settles.
   */
  potentialPoints: number;
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

export async function getActiveCompetitions(
  supabase: SupabaseClient,
): Promise<ActiveCompetition[]> {
  const { data, error } = await supabase
    .from("rounds")
    .select(
      "id, slug, status, prediction_opens_at, prediction_deadline, challenges(title, prompt), round_models(llm_models(id, name))",
    )
    .eq("status", "OPEN")
    .order("prediction_deadline");

  if (error) {
    throw error;
  }

  const now = new Date();
  const active = (data ?? []).filter((competition) =>
    isActiveCompetition(
      {
        status: competition.status,
        prediction_opens_at: competition.prediction_opens_at,
        prediction_deadline: competition.prediction_deadline,
      },
      now,
    ),
  );

  // The pot is the sum of stakes, which a viewer cannot read directly (own-rows
  // only). Stakes are public competition data, so totalling them with the
  // service role is safe and keeps the pool number honest on the card.
  const pots = new Map<string, number>();
  for (const competition of active) {
    const summary = await getRoundStakeSummary(competition.id, supabase);
    pots.set(competition.id, summary.potPoints);
  }

  return active.map((competition) => {
    const challenge = Array.isArray(competition.challenges)
      ? competition.challenges[0]
      : competition.challenges;
    const models = (competition.round_models ?? [])
      .flatMap((roundModel) =>
        Array.isArray(roundModel.llm_models)
          ? roundModel.llm_models
          : [roundModel.llm_models],
      )
      .map((model) => model?.name)
      .filter((name): name is string => Boolean(name));

    return {
      id: competition.id,
      title: competition.slug,
      challengePreview: challenge?.prompt ?? "",
      models,
      deadline: competition.prediction_deadline,
      status: "OPEN" as const,
      potentialPoints: pots.get(competition.id) ?? 0,
    };
  });
}
