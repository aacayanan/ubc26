import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import {
  LEADERBOARD_LIMIT,
  getLeaderboard,
} from "@/lib/server/services/leaderboard/leaderboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Public read. The response carries only sanitized display names, opaque
// keys and prediction tallies — no user ids, emails, wallets or roles.
export async function GET(request: Request) {
  return withApiErrorHandling(request, async () => {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Wagers are owner-only under RLS, so tallies are read with the service
    // role; nothing but counts and sanitized names is returned.
    const leaderboard = await getLeaderboard(
      getServiceRoleSupabase(),
      user?.id ?? null,
    );

    return Response.json(
      {
        entries: leaderboard.entries.map((entry, index) => ({
          key: entry.key,
          rank: entry.rank,
          tied: entry.tied,
          display_name: entry.displayName,
          pseudonymous: entry.pseudonymous,
          correct_predictions: entry.correctPredictions,
          decided_predictions: entry.decidedPredictions,
          is_viewer: entry.isViewer,
          // The viewer's own row, appended after the top list.
          outside_top: index >= LEADERBOARD_LIMIT,
        })),
        total_ranked: leaderboard.totalRanked,
      },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
