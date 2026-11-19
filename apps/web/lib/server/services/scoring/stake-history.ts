import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { InternalError } from "@/lib/server/errors/app-error";

/**
 * A user's stake history (F26, minimal slice).
 *
 * The `predictions` table already holds everything a stake row needs, and RLS
 * scopes reads to the owner — but the page is a client component with no API,
 * so this reads with the service role for an explicit user id instead.
 *
 * Points are settled, not escrowed (F18): an open stake shows its `stake_points`
 * with no outcome; a settled one shows `settlement_outcome` and what it returned.
 */

export type StakeOutcome = "won" | "lost" | "void" | null;

export interface StakeRecord {
  id: string;
  roundId: string;
  briefTitle: string;
  pickedModel: string;
  /** What the account put at risk. */
  points: number;
  /** What it returned; null until the round settles. */
  awarded: number | null;
  outcome: StakeOutcome;
  roundStatus: string;
  createdAt: string;
}

export async function listUserStakes(
  userId: string,
  supabase: SupabaseClient,
): Promise<StakeRecord[]> {
  const { data, error } = await supabase
    .from("predictions")
    .select(
      "id, round_id, model_id, stake_points, points_awarded, settlement_outcome, created_at, rounds(status, challenges(title)), llm_models(name)",
    )
    .eq("user_id", userId)
    .eq("category", "conformance")
    .order("created_at", { ascending: false });

  if (error) {
    throw new InternalError("Failed to read your stakes", error);
  }

  return (
    (data ?? []) as Array<{
      id: string;
      round_id: string;
      stake_points: number | null;
      points_awarded: number | null;
      settlement_outcome: string | null;
      created_at: string;
      rounds:
        | {
            status: string;
            challenges: { title: string } | Array<{ title: string }> | null;
          }
        | Array<{
            status: string;
            challenges: { title: string } | Array<{ title: string }> | null;
          }>
        | null;
      llm_models: { name: string } | Array<{ name: string }> | null;
    }>
  ).map((row) => {
    const round = Array.isArray(row.rounds) ? row.rounds[0] : row.rounds;
    const challenge = Array.isArray(round?.challenges)
      ? round.challenges[0]
      : round?.challenges;
    const model = Array.isArray(row.llm_models)
      ? row.llm_models[0]
      : row.llm_models;

    const outcome =
      row.settlement_outcome === "won" ||
      row.settlement_outcome === "lost" ||
      row.settlement_outcome === "void"
        ? row.settlement_outcome
        : null;

    return {
      id: row.id,
      roundId: row.round_id,
      briefTitle: challenge?.title ?? "Round",
      pickedModel: model?.name ?? "Model",
      points: row.stake_points ?? 0,
      awarded: outcome === null ? null : (row.points_awarded ?? 0),
      outcome,
      roundStatus: round?.status ?? "",
      createdAt: row.created_at,
    };
  });
}
