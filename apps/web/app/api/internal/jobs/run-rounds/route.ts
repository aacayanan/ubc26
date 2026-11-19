import { assertInternalJobRequest } from "@/lib/server/services/competitions/job-auth";
import { ValidationError } from "@/lib/server/errors/app-error";
import { withApiErrorHandling } from "@/lib/server/http/api-error";
import {
  listRoundsForPipeline,
  runRoundPipeline,
  type RunRoundPipelineResult,
} from "@/lib/server/services/pipeline/run-round";

/**
 * Internal pipeline job (F17).
 *
 * POST /api/internal/jobs/run-rounds
 *   Header: x-internal-job-secret: <INTERNAL_JOB_SECRET>
 *   Body (all optional): { "roundId"?: uuid, "limit"?: 1..20 }
 *
 * With `roundId`, runs exactly that round. Without it, picks up every round in
 * a runnable state (LOCKED, or RUNNING/EVALUATING/RETRYING left mid-flight) and
 * drives it through to per-model verdicts.
 *
 * Safe to call twice: every stage of the pipeline is keyed so a re-run resumes
 * rather than duplicating, and an already-finished round is refused rather than
 * re-run — see `assertRunnable`.
 *
 * This endpoint does NOT settle. It produces verdicts; F15's resolver and F18's
 * settlement turn those into an outcome. Keeping the two apart is what lets a
 * judge outage leave a round retryable instead of settled on a guess.
 */

interface RunRoundsRequest {
  roundId?: string;
  limit?: number;
}

const MAX_ROUNDS_PER_CALL = 20;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseBody(raw: unknown): RunRoundsRequest {
  if (raw === null || raw === undefined) return {};

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("Body must be a JSON object");
  }

  const body = raw as Record<string, unknown>;

  if (body.roundId !== undefined) {
    if (typeof body.roundId !== "string" || !UUID_PATTERN.test(body.roundId)) {
      throw new ValidationError("roundId must be a UUID");
    }
  }

  let limit: number | undefined;
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number") {
      throw new ValidationError("limit must be a number");
    }
    if (
      !Number.isInteger(body.limit) ||
      body.limit <= 0 ||
      body.limit > MAX_ROUNDS_PER_CALL
    ) {
      throw new ValidationError(
        `limit must be an integer between 1 and ${MAX_ROUNDS_PER_CALL}`,
      );
    }
    limit = body.limit;
  }

  return {
    ...(body.roundId !== undefined ? { roundId: body.roundId as string } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export async function POST(request: Request) {
  return withApiErrorHandling(request, async (correlationId) => {
    assertInternalJobRequest(request);

    const body = parseBody(await readJson(request));

    const targets = body.roundId
      ? [{ id: body.roundId }]
      : await listRoundsForPipeline({
          limit: body.limit ?? MAX_ROUNDS_PER_CALL,
        });

    const results: RunRoundPipelineResult[] = [];

    // Sequential on purpose: a single host has one Docker daemon and a limited
    // memory budget, and running rounds in parallel is how a demo times out.
    for (const target of targets) {
      results.push(
        await runRoundPipeline({ roundId: target.id, correlationId }),
      );
    }

    return Response.json(
      {
        ok: true,
        correlationId,
        ranCount: results.length,
        rounds: results.map((result) => ({
          roundId: result.roundId,
          slug: result.slug,
          judged: result.judged,
          models: result.models.map((model) => ({
            modelId: model.modelId,
            name: model.name,
            gatePassed: model.gate.passed,
            generationForfeited: model.generationForfeited,
            judge: model.judge?.kind ?? null,
            reason:
              model.generationFailureReason ??
              model.judge?.reason ??
              model.gate.failureReason,
          })),
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
