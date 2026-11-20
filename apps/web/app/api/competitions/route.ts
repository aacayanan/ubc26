import { withApiErrorHandling } from "@/lib/server/http/api-error";
import {
  getActiveCompetitions,
  getLiveCompetitions,
} from "@/lib/server/services/competitions/active-competitions";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";

/**
 * GET /api/competitions — the open-round list and what is running (F9, F27).
 *
 * Public. Reads through the service role because the pot and the per-model split
 * are aggregates over other accounts' stakes, which RLS scopes to their owners;
 * only totals leave this handler.
 *
 * `live` is a separate array rather than a status field on the same rows: an
 * open round and a running round answer different questions ("can I stake?" vs
 * "what is happening?"), and the two clocks keep them from overlapping.
 */
export async function GET(request: Request) {
  return withApiErrorHandling(request, async () => {
    const supabase = getServiceRoleSupabase();
    const [active, live] = await Promise.all([
      getActiveCompetitions(supabase),
      // The strip is a convenience for a viewer; a live read failing must not
      // take the staking list down with it.
      getLiveCompetitions(supabase).catch(() => []),
    ]);

    const competitions = active.map((competition) => ({
      id: competition.id,
      title: competition.title,
      challenge_preview: competition.challengePreview,
      models: competition.models,
      deadline: competition.deadline,
      status: competition.status,
      potential_points: competition.potentialPoints,
      pool_capacity: competition.poolCapacity,
      odds: competition.odds.map((model) => ({
        model_id: model.modelId,
        model_name: model.modelName,
        staked: model.staked,
        multiplier: model.multiplier,
        share: model.share,
      })),
    }));

    return Response.json(
      {
        competitions,
        live: live.map((round) => ({
          id: round.id,
          title: round.title,
          status: round.status,
          models: round.models,
          progress: round.progress,
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
