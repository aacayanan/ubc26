import { withApiErrorHandling } from "@/lib/server/http/api-error";
import {
  LEADERBOARD_LIMIT,
  getLeaderboard,
} from "@/lib/server/services/leaderboard/leaderboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Public read. The response carries only sanitized display names, opaque
// keys and settled totals — no user ids, emails, wallets or roles.
export async function GET(request: Request) {
  return withApiErrorHandling(request, async () => {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const leaderboard = await getLeaderboard(supabase, user?.id ?? null);

    return Response.json(
      {
        entries: leaderboard.entries.map((entry, index) => ({
          key: entry.key,
          rank: entry.rank,
          tied: entry.tied,
          display_name: entry.displayName,
          pseudonymous: entry.pseudonymous,
          points: entry.points,
          settled_rounds: entry.settledRounds,
          streak: entry.streak,
          hit_rate: entry.hitRate,
          is_viewer: entry.isViewer,
          // The viewer's own row, appended after the top list.
          outside_top: index >= LEADERBOARD_LIMIT,
        })),
        total_ranked: leaderboard.totalRanked,
        pending: {
          streaks: leaderboard.pending.streaks,
          hit_rate: leaderboard.pending.hitRate,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
