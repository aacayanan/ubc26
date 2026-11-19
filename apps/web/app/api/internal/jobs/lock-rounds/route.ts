import { assertInternalJobRequest } from "@/lib/server/services/competitions/job-auth";
import {
  assertLockLimit,
  lockDueRounds,
  type LockDueRoundsResult,
} from "@/lib/server/services/competitions/lock";
import { ValidationError } from "@/lib/server/errors/app-error";
import { withApiErrorHandling } from "@/lib/server/http/api-error";

/**
 * Internal deadline job (F11).
 *
 * POST /api/internal/jobs/lock-rounds
 *   Header: x-internal-job-secret: <INTERNAL_JOB_SECRET>
 *   Body (all optional): { "now"?: ISO-8601, "limit"?: 1..1000, "reason"?: string }
 *
 * Transitions every OPEN round whose prediction deadline has passed to LOCKED
 * and returns what it locked. Safe to call on a schedule, on demand during the
 * demo, or twice in a row — the underlying RPC makes a repeat a no-op, so a
 * response is a description of work done, not a command to do work again.
 *
 * POST rather than GET because it mutates state; a scheduler will call it with
 * `curl -X POST` either way.
 */

interface LockRequest {
  now?: string;
  limit?: number;
  reason?: string;
}

function parseBody(raw: unknown): LockRequest {
  if (raw === null || raw === undefined) return {};

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("Body must be a JSON object");
  }

  const body = raw as Record<string, unknown>;

  if (body.now !== undefined && typeof body.now !== "string") {
    throw new ValidationError("now must be an ISO-8601 string");
  }

  if (body.reason !== undefined && typeof body.reason !== "string") {
    throw new ValidationError("reason must be a string");
  }

  let limit: number | undefined;
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number") {
      throw new ValidationError("limit must be a number");
    }
    assertLockLimit(body.limit);
    limit = body.limit;
  }

  return {
    ...(body.now !== undefined ? { now: body.now as string } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(body.reason !== undefined ? { reason: body.reason as string } : {}),
  };
}

export async function POST(request: Request) {
  return withApiErrorHandling(request, async (correlationId) => {
    assertInternalJobRequest(request);

    const body = parseBody(await readJson(request));

    const result: LockDueRoundsResult = await lockDueRounds({
      ...body,
      correlationId,
    });

    return Response.json(
      {
        ok: true,
        correlationId,
        lockedCount: result.locked.length,
        // True when the batch was full: run again immediately rather than
        // waiting for the next tick.
        hasMore: result.hasMore,
        rounds: result.locked,
      },
      { headers: { "x-correlation-id": correlationId } },
    );
  });
}

/**
 * An empty body is a normal call (a cron sends none). Anything that is not
 * valid JSON is a client error, not a server one.
 */
async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Body must be valid JSON");
  }
}
