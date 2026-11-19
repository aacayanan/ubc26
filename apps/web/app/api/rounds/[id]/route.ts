import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { ValidationError } from "@/lib/server/errors/app-error";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { getRoundDetail } from "@/lib/server/services/competitions/round-detail";

/**
 * Round detail: GET /api/rounds/[id]
 *
 * Public — the brief, contenders and pot are public record. The viewer's own
 * stake is included only when a session is present, scoped to that account. This
 * is what the round page reads to render anything at all; without it the page
 * had no data source and always showed "this round is closed".
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiErrorHandling(request, async () => {
    const { id } = await context.params;

    if (!UUID_PATTERN.test(id)) {
      throw new ValidationError("Round id must be a UUID");
    }

    // Signed-out viewers still see the round; only the stake is viewer-scoped.
    const user = await getAuthenticatedUser();
    const round = await getRoundDetail(id, user?.id ?? null);

    return Response.json(
      {
        round: {
          id: round.id,
          slug: round.slug,
          status: round.status,
          brief_title: round.briefTitle,
          brief_text: round.briefText,
          models: round.models,
          deadline: round.predictionDeadline,
          pool_points: round.poolPoints,
          pool_capacity: round.poolCapacity,
          user_stake: round.viewerStake
            ? {
                model_id: round.viewerStake.modelId,
                points: round.viewerStake.points,
              }
            : null,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
