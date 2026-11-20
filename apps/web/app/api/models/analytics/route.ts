import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getModelAnalytics } from "@/lib/server/services/models/analytics";

/**
 * Historical model performance: GET /api/models/analytics (F25).
 *
 * Public — a record of how models did across settled rounds is public
 * competition data, like the results and the leaderboard. No caching: a round
 * settles and a model's rate changes without a hard refresh.
 *
 * The payload keeps the two records separate and never merges them: conformance
 * (measured) and crowd (subjective). Rounds that produced no result are returned
 * as `gaps` with a reason, not silently absent from every total.
 */
export async function GET(request: Request) {
  return withApiErrorHandling(request, async () => {
    const analytics = await getModelAnalytics(getServiceRoleSupabase());

    return Response.json(
      {
        models: analytics.models.map((model) => ({
          model_id: model.modelId,
          name: model.name,
          rounds: model.rounds,
          settled_rounds: model.settledRounds,
          conformance_wins: model.conformanceWins,
          round_wins: model.roundWins,
          crowd_wins: model.crowdWins,
          forfeits: model.forfeits,
          conformance_rate: model.conformanceRate,
          crowd_win_rate: model.crowdWinRate,
          voided_rounds: model.voidedRounds,
          unsettled_rounds: model.unsettledRounds,
          recent: model.recent.map((fact) => ({
            round_id: fact.roundId,
            round_slug: fact.roundSlug,
            brief_title: fact.briefTitle,
            outcome: fact.outcome,
            conformance: fact.conformance,
            is_winner: fact.winnerModelId === model.modelId,
            is_crowd_pick: fact.fanFavoriteModelId === model.modelId,
            decided_at: fact.decidedAt,
          })),
        })),
        gaps: analytics.gaps.map((gap) => ({
          round_id: gap.roundId,
          round_slug: gap.roundSlug,
          brief_title: gap.briefTitle,
          status: gap.status,
          outcome: gap.outcome,
          reason: gap.reason,
          decided_at: gap.decidedAt,
        })),
        scope: {
          settled_rounds: analytics.scope.settledRounds,
          voided_rounds: analytics.scope.voidedRounds,
          unsettled_rounds: analytics.scope.unsettledRounds,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
