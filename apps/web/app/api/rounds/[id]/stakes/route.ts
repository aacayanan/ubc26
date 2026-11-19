import { ValidationError } from "@/lib/server/errors/app-error";
import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { requireUser } from "@/lib/server/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { placeStake } from "@/lib/server/services/scoring/stakes";

/**
 * Stake on a model (F18/F10).
 *
 * POST /api/rounds/[id]/stakes
 *   Body: { "modelId": uuid, "points": integer >= 10, "commitmentHash"?: string }
 *
 * The user-session client is deliberate: `public.place_stake` identifies the
 * caller with `auth.uid()`, so the service role would place a stake for nobody
 * and the join gate and balance check would be meaningless. Every rule (window,
 * funded, practice mode, over-balance, duplicate) is enforced inside the RPC —
 * this route only parses the body and reports the result.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StakeBody {
  modelId?: unknown;
  points?: unknown;
  commitmentHash?: unknown;
}

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

    const body = (await readJson(request)) as StakeBody;

    if (typeof body.modelId !== "string" || !UUID_PATTERN.test(body.modelId)) {
      throw new ValidationError("modelId must be a UUID");
    }
    if (typeof body.points !== "number") {
      throw new ValidationError("points must be a number");
    }
    if (
      body.commitmentHash !== undefined &&
      typeof body.commitmentHash !== "string"
    ) {
      throw new ValidationError("commitmentHash must be a string");
    }

    const supabase = await createSupabaseServerClient();

    const stake = await placeStake({
      roundId,
      modelId: body.modelId,
      points: body.points,
      commitmentHash:
        typeof body.commitmentHash === "string" ? body.commitmentHash : null,
      supabase,
    });

    return Response.json(
      { ok: true, userId: user.id, stake },
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
