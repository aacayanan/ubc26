import { assertInternalJobRequest } from "@/lib/server/services/competitions/job-auth";
import { ValidationError } from "@/lib/server/errors/app-error";
import { withApiErrorHandling } from "@/lib/server/http/api-error";
import {
  rejudgeRound,
  toJudgeVerdicts,
  type RejudgeRoundResult,
} from "@/lib/server/services/pipeline/rejudge";

/**
 * Operator re-judge job (F31).
 *
 * POST /api/internal/jobs/rejudge
 *   Header: x-internal-job-secret: <INTERNAL_JOB_SECRET>
 *   Body: { "roundId": uuid, "modelId"?: uuid }
 *
 * Asks the seated judge to rule again on a round's *stored* frames. Nothing is
 * generated or rendered: the artifact the pipeline already captured is re-read
 * and re-judged, which is what makes this safe to run after the fact — a judge
 * outage, a malformed reply, or a corrected rubric all want a second pass on the
 * same evidence.
 *
 * It writes `judge_verdicts` (replacing each subject's row) and does not settle
 * the round. F15's resolver and F18's settlement consume the verdicts
 * separately, so re-judging cannot move a pot on its own.
 *
 * `modelId` restricts the run to one competitor; omitted re-judges every
 * eligible model in the round.
 */

interface RejudgeRequest {
  roundId: string;
  modelId?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseBody(raw: unknown): RejudgeRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("Body must be a JSON object");
  }

  const body = raw as Record<string, unknown>;

  if (typeof body.roundId !== "string" || !UUID_PATTERN.test(body.roundId)) {
    throw new ValidationError("roundId must be a UUID");
  }

  if (body.modelId !== undefined) {
    if (typeof body.modelId !== "string" || !UUID_PATTERN.test(body.modelId)) {
      throw new ValidationError("modelId must be a UUID");
    }
  }

  return {
    roundId: body.roundId,
    ...(body.modelId !== undefined ? { modelId: body.modelId as string } : {}),
  };
}

export async function POST(request: Request) {
  return withApiErrorHandling(request, async (correlationId) => {
    assertInternalJobRequest(request);

    const body = parseBody(await readJson(request));

    const result: RejudgeRoundResult = await rejudgeRound({
      roundId: body.roundId,
      subjectModelId: body.modelId,
      correlationId,
    });

    return Response.json(
      {
        ok: true,
        correlationId,
        roundId: result.roundId,
        slug: result.slug,
        judgeModelId: result.judgeModelId,
        allJudged: result.allJudged,
        models: result.models.map((model) => ({
          modelId: model.modelId,
          name: model.name,
          status: model.status,
          // `null` verdict is a skip; the reason says why, so a skip is never
          // mistaken for a ruling.
          verdict: model.verdict?.kind ?? null,
          conformed:
            model.verdict?.kind === "ruled" ? model.verdict.conformed : null,
          reason: model.reason,
        })),
        // The same verdicts F15 would consume, so a caller can chain straight
        // into resolution without re-reading judge_verdicts.
        verdicts: toJudgeVerdicts(result.models).map((entry) => ({
          modelId: entry.modelId,
          kind: entry.verdict.kind,
          conformed:
            entry.verdict.kind === "ruled" ? entry.verdict.conformed : null,
        })),
      },
      { headers: { "x-correlation-id": correlationId } },
    );
  });
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Body must be valid JSON");
  }
}
