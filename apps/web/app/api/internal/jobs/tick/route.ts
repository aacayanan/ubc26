import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { NO_STORE } from "@/lib/server/http/json";
import { assertInternalJobRequest } from "@/lib/server/services/competitions/job-auth";
import { driveRounds } from "@/lib/server/services/automation/round-driver";

/**
 * One pass of the round driver, on demand (the scheduler's manual twin).
 *
 * POST /api/internal/jobs/tick
 *   Header: x-internal-job-secret: <INTERNAL_JOB_SECRET>
 *
 * The in-process scheduler (see `instrumentation.ts`) already runs this every
 * couple of seconds, so this endpoint exists for two reasons: to verify the
 * driver on a deployment without waiting for a deadline, and to stand in for the
 * scheduler when `ROUND_SCHEDULER=off` on a host that should not self-drive.
 *
 * One call locks every due round, settles every finished one, sends queued
 * payouts, and returns the rounds generation may now start on — but it does
 * **not** generate. Generation takes minutes and belongs behind the scheduler,
 * which tracks in-flight rounds; firing it from a request would let a caller
 * start a second generator on the same round.
 */
export async function POST(request: Request) {
  return withApiErrorHandling(request, async (correlationId) => {
    assertInternalJobRequest(request);

    const summary = await driveRounds({ correlationId, runMoney: true });

    return Response.json(
      {
        ok: true,
        correlationId,
        locked: summary.locked,
        settled: summary.settled,
        payouts: summary.payouts,
        reconciles: summary.reconciles,
        pending: summary.pending,
        errors: summary.errors,
      },
      { headers: NO_STORE },
    );
  });
}
