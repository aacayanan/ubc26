import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { NO_STORE, requireUuid } from "@/lib/server/http/json";
import { requireUser } from "@/lib/server/auth";
import { verifyWagerCommitment } from "@/lib/server/services/wagering/verify";

/**
 * Verify your own wager commitment against Solana Devnet (F20).
 *
 * GET /api/wagers/[id]/verify
 *
 * Owner-only: the lookup is scoped to the signed-in account, so another
 * account's wager reads as not found. The response discloses the preimage
 * (pick + nonce) — that is the point, the owner is proving their own
 * commitment — and re-derives every check from the chain on each call.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiErrorHandling(request, async () => {
    const user = await requireUser();
    const { id } = await context.params;
    requireUuid(id, "Wager id");

    const verification = await verifyWagerCommitment({
      wagerId: id,
      ownerId: user.id,
    });

    return Response.json({ verification }, { headers: NO_STORE });
  });
}
