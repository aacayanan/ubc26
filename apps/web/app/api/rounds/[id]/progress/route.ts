import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { ValidationError } from "@/lib/server/errors/app-error";
import { getLiveRoundProgress } from "@/lib/server/services/pipeline/live-progress";

/**
 * Live round progress (F17): GET /api/rounds/[id]/progress
 *
 * Public — a viewer watching a round does not need an account, and everything
 * this returns is already either public record (the brief, model names) or
 * gated behind the round having locked. The two-clocks rule is enforced in
 * `getLiveRoundProgress`, not here, so any other caller inherits it.
 *
 * No caching: the whole point is that it changes as chunks land. A viewer polls
 * this while a round runs.
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

    const progress = await getLiveRoundProgress(id);

    // Previews and code are only ever returned once the round has locked; when
    // it has not, `getLiveRoundProgress` has already blanked them and this
    // header just records that the response is fresh.
    return Response.json(progress, {
      headers: { "cache-control": "no-store" },
    });
  });
}
