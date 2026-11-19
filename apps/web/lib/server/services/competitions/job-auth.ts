import "server-only";

import { timingSafeEqual } from "node:crypto";
import { getInternalJobEnv } from "@/lib/config/server";
import { AuthorizationError } from "@/lib/server/errors/app-error";

/**
 * Shared-secret authorization for internal job endpoints (F11).
 *
 * These endpoints are not user-facing. They are meant for a scheduler, a cron
 * container, or an operator's `curl`, and the only thing standing between an
 * anonymous caller and "lock every round" is this check — so it fails closed:
 * no configured secret means no caller is accepted.
 *
 * The comparison is constant-time to avoid leaking the secret a byte at a time
 * through response timing.
 */
export const INTERNAL_JOB_HEADER = "x-internal-job-secret";

export function assertInternalJobRequest(request: Request): void {
  const { internalJobSecret } = getInternalJobEnv();

  const provided = request.headers.get(INTERNAL_JOB_HEADER) ?? "";
  const expected = internalJobSecret;

  if (!constantTimeEqual(provided, expected)) {
    throw new AuthorizationError("Invalid internal job credentials");
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  // timingSafeEqual requires equal lengths; comparing the length first would
  // leak it, so pad the shorter buffer and let the comparison do the work.
  if (left.length !== right.length) {
    // Still do a comparison so the failure path costs the same either way.
    timingSafeEqual(Buffer.alloc(right.length), right);
    return false;
  }

  return timingSafeEqual(left, right);
}
