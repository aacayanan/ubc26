import {
  AuthenticationError,
  ValidationError,
} from "@/lib/server/errors/app-error";
import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { NO_STORE, readJsonObject, requireUuid } from "@/lib/server/http/json";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { prepareWager } from "@/lib/server/services/wagering/wagers";
import { parseSolToLamports } from "@/lib/sol-pool";

/**
 * Prepare a SOL wager (Devnet only).
 *
 * POST /api/rounds/[id]/wagers/prepare
 *   Body: { modelId: uuid, kind: "ante" | "live", sol?: "0.05", wallet: base58 }
 *
 * Returns an unsigned transaction (transfer + memo, operator as fee payer) for
 * Phantom's signTransaction. Preparing records nothing that counts: the wager
 * exists in the pool only once /submit has verified it on-chain.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiErrorHandling(request, async () => {
    const { id } = await context.params;
    const roundId = requireUuid(id, "Round id");
    const body = await readJsonObject(request);
    const modelId = requireUuid(body.modelId, "modelId");

    if (body.kind !== "ante" && body.kind !== "live") {
      throw new ValidationError('kind must be "ante" or "live"');
    }
    if (
      typeof body.wallet !== "string" ||
      body.wallet.length < 32 ||
      body.wallet.length > 44
    ) {
      throw new ValidationError("wallet must be the connected Phantom address");
    }

    let lamports: bigint | undefined;
    if (body.kind === "live") {
      if (typeof body.sol !== "string")
        throw new ValidationError("sol must be a decimal string");
      try {
        lamports = parseSolToLamports(body.sol);
      } catch {
        throw new ValidationError(
          "sol must be a positive amount with at most 9 decimals",
        );
      }
    }

    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new AuthenticationError();

    const prepared = await prepareWager({
      user,
      roundId,
      modelId,
      kind: body.kind,
      lamports,
      connectedWallet: body.wallet,
    });

    return Response.json(
      { ok: true, wager: prepared },
      { status: 201, headers: NO_STORE },
    );
  });
}
