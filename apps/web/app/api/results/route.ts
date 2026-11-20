import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { listSettledRounds } from "@/lib/server/services/results/results";

/**
 * Settled rounds: GET /api/results (F19).
 *
 * Public — a settled result is public record (the brief, the contenders, which
 * model conformed, which the crowd chose, the pot). The list is the entry point
 * to the results + replay detail at `/results/[id]`.
 *
 * No caching: a round settles and should appear without a hard refresh.
 */
export async function GET(request: Request) {
  return withApiErrorHandling(request, async () => {
    const results = await listSettledRounds();

    return Response.json(
      {
        results: results.map((row) => ({
          round_id: row.roundId,
          slug: row.slug,
          brief_title: row.briefTitle,
          kind: row.kind,
          display_state: row.displayState,
          conformed_model: row.conformedModel,
          crowd_model: row.crowdModel,
          pool_sol: row.poolSol,
          reason: row.reason,
          settled_at: row.settledAt,
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
