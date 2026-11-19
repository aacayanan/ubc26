import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { ValidationError } from "@/lib/server/errors/app-error";
import { requireAdmin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

interface CreateCompetitionBody {
  slug?: unknown;
  name?: unknown;
  challengeId?: unknown;
  modelIds?: unknown;
  predictionDeadline?: unknown;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export async function POST(request: Request) {
  return withApiErrorHandling(request, async () => {
    const admin = await requireAdmin();
    let body: CreateCompetitionBody;
    try {
      body = (await request.json()) as CreateCompetitionBody;
    } catch {
      throw new ValidationError("Request body must be valid JSON");
    }

    const name =
      typeof body.name === "string"
        ? body.name
        : typeof body.slug === "string"
          ? body.slug
          : null;

    if (
      name === null ||
      name.trim().length < 3 ||
      name.trim().length > 120 ||
      !isUuid(body.challengeId) ||
      !Array.isArray(body.modelIds) ||
      body.modelIds.length < 2 ||
      body.modelIds.length > 3 ||
      !body.modelIds.every(isUuid) ||
      typeof body.predictionDeadline !== "string"
    ) {
      throw new ValidationError(
        "Provide a name, published challenge, at least two models, and a deadline",
      );
    }

    const deadline = new Date(body.predictionDeadline);
    if (Number.isNaN(deadline.getTime())) {
      throw new ValidationError("Prediction deadline must be a valid date");
    }
    if (deadline <= new Date()) {
      throw new ValidationError("Prediction deadline must be in the future");
    }
    if (new Set(body.modelIds).size !== body.modelIds.length) {
      throw new ValidationError("Participating models must be unique");
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc("create_competition", {
      p_slug: name.trim(),
      p_challenge_id: body.challengeId,
      p_model_ids: body.modelIds,
      p_prediction_opens_at: new Date().toISOString(),
      p_prediction_deadline: deadline.toISOString(),
      p_created_by: admin.id,
    });

    if (error) {
      throw new ValidationError(error.message);
    }

    return Response.json({ competition: data });
  });
}
