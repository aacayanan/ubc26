import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { ValidationError } from "@/lib/server/errors/app-error";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getRoundStakeSummary } from "@/lib/server/services/scoring/stakes";
import { getViewerStake } from "@/lib/server/services/competitions/round-detail";

/**
 * The live pool, for the market board (F9): GET /api/rounds/[id]/pool
 *
 * Public, like the round itself. Returns the per-model split — which the round
 * detail endpoint does not, because the board prices each side individually —
 * and, when a session is present, the viewer's own stake so a draft can be
 * priced as a replacement rather than an addition.
 *
 * The split is read through the service role: `predictions` is own-rows-only
 * under RLS, and the per-model totals are an aggregate over other accounts'
 * stakes. Only aggregates and the caller's own row leave this handler; who
 * backed what is never disclosed. That is also why no timeline is offered here —
 * a per-stake history would hand a viewer the same disclosure one observation at
 * a time.
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

    const supabase = getServiceRoleSupabase();
    const user = await getAuthenticatedUser();
    const summary = await getRoundStakeSummary(id, supabase);
    const own = user ? await getViewerStake(id, user.id, supabase) : null;

    return Response.json(
      {
        round_id: id,
        pot_points: summary.potPoints,
        stakes_by_model: summary.stakesByModel,
        viewer_stake: own,
      },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
