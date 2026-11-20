import "server-only";

import { ConflictError, InternalError } from "@/lib/server/errors/app-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { recordSolSettlement } from "./sol-settlement";

/**
 * Full refunds for a CANCELLED SOL round. Cancelling closes betting (trigger);
 * this finalizes the pool and records a refund settlement, which queues one
 * refund per bettor. The payout job then sends them.
 */
export async function refundCancelledRound(
  roundId: string,
): Promise<Record<string, unknown>> {
  const supabase = getServiceRoleSupabase();
  const { data: round, error } = await supabase
    .from("rounds")
    .select("status, wagering_mode")
    .eq("id", roundId)
    .maybeSingle();
  if (error) throw new InternalError("Failed to read the round", error);
  if (!round || round.wagering_mode !== "devnet_sol") {
    throw new ConflictError("Not a SOL round");
  }
  if (round.status !== "CANCELLED") {
    throw new ConflictError(
      `Round is ${round.status}; only a CANCELLED round refunds this way`,
    );
  }

  const { data: models } = await supabase
    .from("round_models")
    .select("model_id, ordinal")
    .eq("round_id", roundId)
    .order("ordinal", { ascending: true });

  return recordSolSettlement({
    roundId,
    conformedModelIds: [],
    modelOrder: (models ?? []).map((m) => m.model_id as string),
    voided: true,
    supabase,
  });
}
