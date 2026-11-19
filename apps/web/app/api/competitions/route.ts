import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { getActiveCompetitions } from "@/lib/server/services/competitions/active-competitions";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  return withApiErrorHandling(request, async () => {
    const supabase = await createSupabaseServerClient();
    const active = await getActiveCompetitions(supabase);
    const competitions = active.map((competition) => ({
      id: competition.id,
      title: competition.title,
      challenge_preview: competition.challengePreview,
      models: competition.models,
      deadline: competition.deadline,
      status: competition.status,
      potential_points: competition.potentialPoints,
    }));

    return Response.json(
      { competitions },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
