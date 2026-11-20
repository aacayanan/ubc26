import { ValidationError } from "@/lib/server/errors/app-error";
import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { NO_STORE, readJsonObject, requireUuid } from "@/lib/server/http/json";
import { requireUser } from "@/lib/server/auth";
import { submitWager } from "@/lib/server/services/wagering/wagers";

/**
 * Submit a wallet-signed wager (Devnet only).
 *
 * POST /api/rounds/[id]/wagers/submit
 *   Body: { wagerId: uuid, signedTransaction: base64 }
 *
 * The server checks the bytes against what it prepared, re-checks the betting
 * window under the round lock, co-signs, broadcasts, waits for Devnet
 * confirmation and re-verifies the landed transaction. The response status is
 * the truth: only `accepted` is a wager in the pool.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiErrorHandling(request, async () => {
    const user = await requireUser();
    const { id } = await context.params;
    requireUuid(id, "Round id");
    const body = await readJsonObject(request);
    const wagerId = requireUuid(body.wagerId, "wagerId");

    if (
      typeof body.signedTransaction !== "string" ||
      body.signedTransaction.length === 0 ||
      body.signedTransaction.length > 4096
    ) {
      throw new ValidationError(
        "signedTransaction must be a base64 transaction",
      );
    }

    const result = await submitWager({
      userId: user.id,
      wagerId,
      signedTransaction: body.signedTransaction,
    });

    return Response.json(
      { ok: result.status === "accepted", wager: result },
      { headers: NO_STORE },
    );
  });
}
