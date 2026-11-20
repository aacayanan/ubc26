import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { NO_STORE, requireUuid } from "@/lib/server/http/json";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { getPoolView } from "@/lib/server/services/wagering/pool";
import { listUserWagers } from "@/lib/server/services/wagering/wagers";
import { listUserPayouts } from "@/lib/server/services/wagering/payouts";
import { WAGER_LIMITS } from "@/lib/server/services/wagering/limits";
import { quoteLiveMinimum } from "@/lib/server/services/wagering/quote";

/**
 * Live SOL pool for a round: GET /api/rounds/[id]/pool
 *
 * Public aggregates (totals and estimated multipliers from accepted wagers
 * only). A signed-in viewer also gets their own wagers and payouts. Never
 * cached: a stale pool could show betting open after it closed.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiErrorHandling(request, async () => {
    const { id } = await context.params;
    const roundId = requireUuid(id, "Round id");

    const pool = await getPoolView(roundId);
    const user = await getAuthenticatedUser();

    const mine = user
      ? {
          wagers: await listUserWagers(user.id, roundId),
          payouts: await listUserPayouts(user.id, roundId),
          canWager: user.role !== "admin",
        }
      : null;

    // The $3 live minimum in lamports at the cached reference price, for the
    // wager form. Advisory only: prepare re-checks it. A price outage hides
    // the hint instead of failing the pool read.
    const liveMinimum = await quoteLiveMinimum(WAGER_LIMITS.minLiveUsdCents)
      .then((quote) => ({
        usdCents: quote.minUsdCents,
        lamports: quote.minLamports,
      }))
      .catch(() => null);

    return Response.json({ pool, mine, liveMinimum }, { headers: NO_STORE });
  });
}
