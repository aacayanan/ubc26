import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { requireUser } from "@/lib/server/auth";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { listUserStakes } from "@/lib/server/services/scoring/stake-history";

/**
 * The signed-in account's stakes: GET /api/stakes
 *
 * Scoped to the caller by `requireUser()` — there is no user id parameter, so
 * this endpoint cannot be used to read anyone else's history. The read runs with
 * the service role because `predictions` RLS is own-rows-only and the page is a
 * client component; the scoping is enforced here, in the query.
 */

export async function GET(request: Request) {
  return withApiErrorHandling(request, async () => {
    const user = await requireUser();
    const stakes = await listUserStakes(user.id, getServiceRoleSupabase());

    return Response.json(
      { stakes },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
