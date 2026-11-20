import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { InternalError, NotFoundError } from "@/lib/server/errors/app-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { estimatePool } from "@/lib/sol-pool";

/**
 * The live pool for a SOL round (F18/F27).
 *
 * Read through the service role because wagers are owner-select only; only
 * aggregates leave this function. Multipliers come from ACCEPTED wagers only —
 * a wager still confirming is counted separately as pending and moves nothing.
 * While betting is open the multipliers are estimates; once the pool is
 * finalized, the frozen `final_pool` is what is reported.
 */

export interface PoolView {
  roundId: string;
  wageringMode: string;
  bettingPhase: "ante" | "live" | "closed";
  bettingClosedAt: string | null;
  bettingCloseReason: string | null;
  bettingCloseModelId: string | null;
  feeBps: number;
  anteUsdCents: number;
  /** The ladder step this round was opened at; null for a legacy round. */
  tier: string | null;
  /** The tier's display name ("Frontier"), or null with `tier`. */
  tierLabel: string | null;
  cutoffBps: number;
  tokenBudgetPerModel: number | null;
  treasuryAddress: string | null;
  final: boolean;
  grossLamports: string;
  feeLamports: string;
  netLamports: string;
  pendingWagers: number;
  acceptedWagers: number;
  bettors: number;
  models: Array<{
    modelId: string;
    stakedLamports: string;
    share: number;
    multiplier: number | null;
  }>;
  settlement: Record<string, unknown> | null;
  /**
   * Output tokens per model from stored (therefore already visible) chunks.
   * `estimated` when a provider omitted usage and chars/3 was counted.
   */
  meters: Record<string, { tokens: number; estimated: boolean }>;
}

async function readMeters(
  roundId: string,
  supabase: SupabaseClient,
): Promise<PoolView["meters"]> {
  const { data: executions } = await supabase
    .from("model_executions")
    .select("id, model_id")
    .eq("round_id", roundId)
    .eq("run_type", "generation");
  const byExecution = new Map(
    (executions ?? []).map((e) => [e.id as string, e.model_id as string]),
  );
  const meters: PoolView["meters"] = {};
  for (const modelId of byExecution.values())
    meters[modelId] = { tokens: 0, estimated: false };
  if (byExecution.size === 0) return meters;

  const { data: chunks } = await supabase
    .from("generation_chunks")
    .select("execution_id, output_tokens, source")
    .in("execution_id", [...byExecution.keys()]);
  for (const chunk of chunks ?? []) {
    const modelId = byExecution.get(chunk.execution_id as string);
    if (!modelId) continue;
    const meter = meters[modelId];
    if (typeof chunk.output_tokens === "number") {
      meter.tokens += chunk.output_tokens;
    } else {
      meter.tokens += Math.ceil(String(chunk.source ?? "").length / 3);
      meter.estimated = true;
    }
  }
  return meters;
}

export async function getPoolView(
  roundId: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<PoolView> {
  const { data: round, error } = await supabase
    .from("rounds")
    .select(
      "id, wagering_mode, betting_phase, betting_closed_at, betting_close_reason, betting_close_model_id, fee_bps, ante_usd_cents, tier, model_tiers(label), cutoff_bps, token_budget_per_model, treasury_address, pool_locked_at, final_pool, sol_settlement",
    )
    .eq("id", roundId)
    .maybeSingle();
  if (error) throw new InternalError("Failed to read the round pool", error);
  if (!round) throw new NotFoundError("Round not found");

  // The embedded `model_tiers` is an object for a to-one join; tolerate the
  // array shape some generated types use.
  const tierEmbed = round.model_tiers as
    { label: string } | Array<{ label: string }> | null;
  const tierLabel = Array.isArray(tierEmbed)
    ? (tierEmbed[0]?.label ?? null)
    : (tierEmbed?.label ?? null);

  const { data: models } = await supabase
    .from("round_models")
    .select("model_id, ordinal")
    .eq("round_id", roundId)
    .order("ordinal", { ascending: true });
  const modelIds = (models ?? []).map((m) => m.model_id as string);

  const wagers: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error: wagerError } = await supabase
      .from("wagers")
      .select("model_id, lamports, status, user_id")
      .eq("round_id", roundId)
      .in("status", ["submitted", "accepted"])
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (wagerError)
      throw new InternalError("Failed to read the round's wagers", wagerError);
    wagers.push(...((page ?? []) as Array<Record<string, unknown>>));
    if (!page || page.length < 1000) break;
  }

  const accepted = (wagers ?? []).filter((w) => w.status === "accepted");
  const pending = (wagers ?? []).filter((w) => w.status === "submitted").length;
  const bettors = new Set(accepted.map((w) => w.user_id as string)).size;

  const estimate = estimatePool({
    modelIds,
    wagers: accepted.map((w) => ({
      modelId: w.model_id as string,
      lamports: BigInt(w.lamports as string | number),
    })),
    feeBps: Number(round.fee_bps),
  });
  const frozen = round.final_pool as {
    byModel?: Record<string, string>;
    feeBps?: number;
  } | null;
  const displayEstimate =
    round.pool_locked_at && frozen?.byModel
      ? estimatePool({
          modelIds,
          wagers: Object.entries(frozen.byModel).map(([modelId, lamports]) => ({
            modelId,
            lamports: BigInt(lamports),
          })),
          feeBps: Number(frozen.feeBps ?? round.fee_bps),
        })
      : estimate;

  const settlement =
    (round.sol_settlement as Record<string, unknown> | null) ?? null;
  const finalGross = settlement?.gross as string | undefined;
  const finalFee = settlement?.fee as string | undefined;
  const finalNet = settlement?.net as string | undefined;
  return {
    roundId,
    wageringMode: round.wagering_mode as string,
    bettingPhase: round.betting_phase as PoolView["bettingPhase"],
    bettingClosedAt: (round.betting_closed_at as string | null) ?? null,
    bettingCloseReason: (round.betting_close_reason as string | null) ?? null,
    bettingCloseModelId:
      (round.betting_close_model_id as string | null) ?? null,
    feeBps: Number(round.fee_bps),
    anteUsdCents: Number(round.ante_usd_cents),
    tier: (round.tier as string | null) ?? null,
    tierLabel,
    cutoffBps: Number(round.cutoff_bps),
    tokenBudgetPerModel:
      round.token_budget_per_model === null
        ? null
        : Number(round.token_budget_per_model),
    treasuryAddress: (round.treasury_address as string | null) ?? null,
    final: round.pool_locked_at !== null,
    grossLamports:
      round.pool_locked_at && finalGross
        ? finalGross
        : displayEstimate.gross.toString(),
    feeLamports:
      round.pool_locked_at && finalFee
        ? finalFee
        : displayEstimate.fee.toString(),
    netLamports:
      round.pool_locked_at && finalNet
        ? finalNet
        : displayEstimate.net.toString(),
    pendingWagers: pending,
    acceptedWagers: accepted.length,
    bettors,
    models: displayEstimate.models.map((m) => ({
      modelId: m.modelId,
      stakedLamports: m.staked.toString(),
      share: m.share,
      multiplier: m.multiplier,
    })),
    settlement,
    meters: await readMeters(roundId, supabase),
  };
}
