import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoundStatus } from "@ai-showdown/shared";
import { InternalError, NotFoundError } from "@/lib/server/errors/app-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getBriefById } from "@/lib/server/services/briefs/briefs";
import { DEFAULT_POOL_CAPACITY } from "@/lib/server/services/competitions/active-competitions";
import { getRoundStakeSummary } from "@/lib/server/services/scoring/stakes";

/**
 * One round's detail, for the round page (F19-adjacent; unblocks the F18 stake
 * flow, which had nowhere to read the round from).
 *
 * Everything here is either public record (the brief, the participating models,
 * the pot) or scoped to the viewer (their own stake). The pot is summed with the
 * service role because a viewer holds no grant to read other accounts' stakes —
 * the total is public competition data, the rows are not.
 */

export interface RoundDetail {
  id: string;
  slug: string;
  status: RoundStatus;
  briefTitle: string;
  briefText: string;
  models: Array<{ id: string; name: string }>;
  predictionDeadline: string;
  /** Live pot: every conformance stake on the round. */
  poolPoints: number;
  /**
   * A soft ceiling for the meter. There is no stake cap in the data model, so
   * this is a display scale, not an enforced limit; the meter clamps at 100%.
   */
  poolCapacity: number;
  /** The viewer's own open stake, or null (also null when signed out). */
  viewerStake: { modelId: string; points: number } | null;
}

export async function getRoundDetail(
  roundId: string,
  viewerId: string | null,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<RoundDetail> {
  const { data: roundData, error: roundError } = await supabase
    .from("rounds")
    .select(
      "id, slug, status, challenge_id, prediction_deadline, challenges(title, prompt), round_models(ordinal, llm_models(id, name))",
    )
    .eq("id", roundId)
    .maybeSingle();

  if (roundError) {
    throw new InternalError("Failed to read the round", roundError);
  }
  if (!roundData) {
    throw new NotFoundError(`Round ${roundId} does not exist`);
  }

  const round = roundData as {
    id: string;
    slug: string;
    status: RoundStatus;
    challenge_id: string;
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
  };

  // Prefer the brief record, but fall back to the round's own challenge row.
  //
  // `getBriefById` only returns JavaScript briefs (it filters `language`), so a
  // round opened against a legacy challenge got `null` here — and the page then
  // rendered the slug as the title and an empty body. The list page reads the
  // challenge directly and shows it fine, so the detail page has to as well.
  const brief = await getBriefById(round.challenge_id, supabase);
  const challenge = Array.isArray(round.challenges)
    ? round.challenges[0]
    : round.challenges;

  const briefTitle = brief?.title ?? challenge?.title ?? round.slug;
  const briefText = brief?.prompt ?? challenge?.prompt ?? "";

  // Participants come from `round_models`, not the active lineup: a round
  // competes the models it was opened against, which is also who backers could
  // stake on.
  const models = (round.round_models ?? [])
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .flatMap((row) =>
      Array.isArray(row.llm_models) ? row.llm_models : [row.llm_models],
    )
    .filter((model): model is { id: string; name: string } =>
      Boolean(model?.id),
    )
    .map((model) => ({ id: model.id, name: model.name }));

  const { potPoints } = await getRoundStakeSummary(round.id, supabase);

  const viewerStake = viewerId
    ? await getViewerStake(round.id, viewerId, supabase)
    : null;

  return {
    id: round.id,
    slug: round.slug,
    status: round.status,
    briefTitle,
    briefText,
    models,
    predictionDeadline: round.prediction_deadline,
    poolPoints: potPoints,
    poolCapacity: Math.max(DEFAULT_POOL_CAPACITY, potPoints),
    viewerStake,
  };
}

/**
 * The viewer's own conformance stake on a round, or null.
 *
 * Exported because the market board's draft pricing needs the same row (it is
 * priced as a *replacement*, since `place_stake` upserts one stake per account
 * per round) and the two callers must not disagree about what the viewer holds.
 */
export async function getViewerStake(
  roundId: string,
  viewerId: string,
  supabase: SupabaseClient,
): Promise<RoundDetail["viewerStake"]> {  const { data, error } = await supabase
    .from("predictions")
    .select("model_id, stake_points")
    .eq("round_id", roundId)
    .eq("user_id", viewerId)
    .eq("category", "conformance")
    .maybeSingle();

  if (error) {
    throw new InternalError("Failed to read your stake", error);
  }
  if (!data) return null;

  const row = data as { model_id: string; stake_points: number | null };
  return { modelId: row.model_id, points: row.stake_points ?? 0 };
}
