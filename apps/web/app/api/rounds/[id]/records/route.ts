import { connection } from "next/server";
import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { NO_STORE, requireUuid } from "@/lib/server/http/json";
import { getRoundChainRecords } from "@/lib/server/services/wagering/round-records";

/**
 * A round's on-chain records (F21): GET /api/rounds/[id]/records[?check=1]
 *
 * Public — memo text and signatures are public on Devnet anyway. Each record
 * says whether its memo agrees with the round's stored id, deadline and rules.
 * `check=1` also reads every confirmed transaction back from Devnet (one RPC
 * read per record), so the page asks for it only when a viewer clicks.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiErrorHandling(request, async () => {
    // Request time only. This route reads no session, so without this Next's
    // runtime prerender pass (cacheComponents + partialPrefetching) would run
    // the Devnet read and trip its current-time / randomness checks.
    await connection();
    const { id } = await context.params;
    const roundId = requireUuid(id, "Round id");
    const checkChain = new URL(request.url).searchParams.get("check") === "1";

    const records = await getRoundChainRecords(roundId, { checkChain });
    return Response.json(records, { headers: NO_STORE });
  });
}
