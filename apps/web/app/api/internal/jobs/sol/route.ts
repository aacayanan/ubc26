import { ValidationError } from "@/lib/server/errors/app-error";
import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { NO_STORE, readJsonObject, requireUuid } from "@/lib/server/http/json";
import { assertInternalJobRequest } from "@/lib/server/services/competitions/job-auth";
import { reconcileSubmittedWagers } from "@/lib/server/services/wagering/wagers";
import { processPayouts } from "@/lib/server/services/wagering/payouts";
import { refundCancelledRound } from "@/lib/server/services/wagering/refunds";

/**
 * SOL wagering jobs (Devnet only). Internal: x-internal-job-secret required.
 *
 * POST /api/internal/jobs/sol
 *   { "action": "reconcile", "roundId"?: uuid }   resolve wagers still confirming
 *   { "action": "payouts",   "roundId"?: uuid }   send / resolve queued payouts
 *   { "action": "refund-cancelled", "roundId": uuid }
 *                                                 queue full refunds for a CANCELLED round
 *
 * All are safe to repeat.
 */
export async function POST(request: Request) {
  return withApiErrorHandling(request, async () => {
    assertInternalJobRequest(request);
    const body = await readJsonObject(request);
    const roundId =
      body.roundId === undefined
        ? undefined
        : requireUuid(body.roundId, "roundId");

    switch (body.action) {
      case "reconcile":
        return Response.json(
          { ok: true, result: await reconcileSubmittedWagers(roundId) },
          { headers: NO_STORE },
        );
      case "payouts":
        return Response.json(
          { ok: true, result: await processPayouts({ roundId }) },
          { headers: NO_STORE },
        );
      case "refund-cancelled":
        if (!roundId) throw new ValidationError("roundId is required");
        return Response.json(
          { ok: true, result: await refundCancelledRound(roundId) },
          { headers: NO_STORE },
        );
      default:
        throw new ValidationError(
          'action must be "reconcile", "payouts" or "refund-cancelled"',
        );
    }
  });
}
