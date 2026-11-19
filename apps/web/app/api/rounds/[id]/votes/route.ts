import { ValidationError } from "@/lib/server/errors/app-error";
import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { requireUser } from "@/lib/server/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { castVote } from "@/lib/server/services/scoring/votes";

/**
 * Cast a crowd vote (F18/F32).
 *
 * POST /api/rounds/[id]/votes
 *   Body: { "modelId": uuid }
 *
 * One vote per account per round, and only after the round has locked — both
 * enforced inside `public.cast_vote`, so a direct call cannot vote before the
 * betting window closes. F32 owns the voting surface; this endpoint is the
 * minimum settlement needs to have something to read.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiErrorHandling(request, async () => {
    const user = await requireUser();
    const { id: roundId } = await context.params;

    if (!UUID_PATTERN.test(roundId)) {
      throw new ValidationError("Round id must be a UUID");
    }

    const body = (await readJson(request)) as { modelId?: unknown };

    if (typeof body.modelId !== "string" || !UUID_PATTERN.test(body.modelId)) {
      throw new ValidationError("modelId must be a UUID");
    }

    const supabase = await createSupabaseServerClient();
    const vote = await castVote({ roundId, modelId: body.modelId, supabase });

    return Response.json(
      { ok: true, userId: user.id, vote },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  });
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Body must be valid JSON");
  }
}
