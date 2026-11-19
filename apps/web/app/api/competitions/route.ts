import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { getActiveCompetitions } from "@/lib/server/services/competitions/active-competitions";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";

/**
 * GET /api/competitions — the open-round list (F9).
 *
 * Public. Reads through the service role because the pot and the per-model split
 * are aggregates over other accounts' stakes, which RLS scopes to their owners;
 * only totals leave this handler.
 */
export async function GET(request: Request) {
  return withApiErrorHandling(request, async () => {
    const active = await getActiveCompetitions(getServiceRoleSupabase());
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
      { competitions },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
