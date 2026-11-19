import { assertInternalJobRequest } from "@/lib/server/services/competitions/job-auth";
import { ValidationError } from "@/lib/server/errors/app-error";
import { withApiErrorHandling } from "@/lib/server/http/api-error";
import {
  listRoundsAwaitingSettlement,
  settleRound,
  type SettleRoundResult,
} from "@/lib/server/services/scoring/settlement";

/**
 * Internal settlement job (F18).
 *
 * POST /api/internal/jobs/settle-rounds
 *   Header: x-internal-job-secret: <INTERNAL_JOB_SECRET>
 *   Body (all optional): { "roundId"?: uuid, "limit"?: 1..20 }
 *
 * With `roundId`, settles exactly that round. Without it, settles every round in
 * EVALUATING — the state the pipeline (F17) leaves a round in once every verdict
 * is in. This endpoint does not run the pipeline; it only turns stored verdicts
 * into an outcome and a payout.
 *
 * Safe to call twice. An already-final round is reported, not re-settled, and a
 * round that cannot be decided (a judge outage the pipeline has not retried yet)
 * writes nothing and is left for the next tick.
 */

interface SettleRoundsRequest {
  roundId?: string;
  limit?: number;
}

const MAX_ROUNDS_PER_CALL = 20;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseBody(raw: unknown): SettleRoundsRequest {
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
      ? [{ id: body.roundId, slug: "" }]
      : await listRoundsAwaitingSettlement({
          limit: body.limit ?? MAX_ROUNDS_PER_CALL,
        });

    const results: SettleRoundResult[] = [];

    // Sequential: settlement touches shared balances, and a single host has no
    // reason to overlap it. Per-round failures should not abort the batch.
    for (const target of targets) {
      results.push(await settleRound({ roundId: target.id, correlationId }));
    }

    return Response.json(
      {
        ok: true,
        correlationId,
        settledCount: results.filter(
          (result) => result.status === "settled" || result.status === "voided",
        ).length,
        rounds: results,
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
