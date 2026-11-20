import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { InternalError } from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { closeMemo, sha256Hex } from "./commitment";
import { recordOperatorMemoInBackground } from "./chain-records";

/**
 * Live betting cutoff (F7/F11/F17, SOL prototype).
 *
 * The rule: betting closes when the FIRST model reaches `cutoff_bps` (75%) of
 * its output-token budget — or earlier, when a model finishes or fails, since
 * either reveals outcome information.
 *
 * "Close, then publish": the pipeline calls `beforeReveal` after a chunk comes
 * back from the provider but BEFORE it is stored, previewed or marked finished.
 * If the event trips the cutoff, `close_betting` commits first. So no output
 * past the threshold, and no finished or failed state, is ever visible while a
 * wager can still be accepted.
 *
 * Tokens come from the provider's reported `completion_tokens`. When a provider
 * omits usage, the chunk is counted conservatively as ceil(chars / 3), which
 * over-estimates and so can only close betting early, never late.
 */

export type CloseReason =
  | "token_threshold"
  | "model_finished"
  | "model_failed"
  | "all_models_stopped"
  | "stall"
  | "round_failed"
  | "admin";

export interface MeterEvent {
  modelId: string;
  kind: "chunk" | "finished" | "failed";
  outputTokens?: number | null;
  chars?: number;
  /** The chunk is the model's last (finish_reason stop, or the final chunk). */
  terminal?: boolean;
}

export interface MeterSnapshot {
  budgetTokens: number;
  thresholdTokens: number;
  models: Record<string, { tokens: number; estimated: boolean; state: string }>;
}

export function estimateTokens(
  outputTokens: number | null | undefined,
  chars: number,
): {
  tokens: number;
  estimated: boolean;
} {
  if (
    typeof outputTokens === "number" &&
    Number.isFinite(outputTokens) &&
    outputTokens >= 0
  ) {
    return { tokens: outputTokens, estimated: false };
  }
  return { tokens: Math.ceil(chars / 3), estimated: true };
}

export async function closeBetting(input: {
  roundId: string;
  reason: CloseReason;
  modelId?: string | null;
  snapshot?: MeterSnapshot | null;
  supabase?: SupabaseClient;
}): Promise<{ applicable: boolean; newlyClosed: boolean }> {
  const supabase = input.supabase ?? getServiceRoleSupabase();
  const { data, error } = await supabase.rpc("close_betting", {
    p_round_id: input.roundId,
    p_reason: input.reason,
    p_model_id: input.modelId ?? null,
    p_snapshot: input.snapshot ?? null,
  });
  if (error) throw new InternalError("Failed to close betting", error);

  const result = (data ?? {}) as {
    applicable?: boolean;
    alreadyClosed?: boolean;
    closedAt?: string;
    reason?: string;
  };
  if (!result.applicable) return { applicable: false, newlyClosed: false };

  const newlyClosed = result.alreadyClosed === false;
  if (newlyClosed) {
    logger.info("betting.closed", {
      roundId: input.roundId,
      reason: input.reason,
      modelId: input.modelId ?? null,
    });
    recordOperatorMemoInBackground({
      purpose: "betting_close",
      idempotencyKey: `close:${input.roundId}`,
      roundId: input.roundId,
      memo: closeMemo({
        roundId: input.roundId,
        reason: input.reason,
        closedAt: result.closedAt ?? new Date().toISOString(),
        snapshotHash: sha256Hex(JSON.stringify(input.snapshot ?? {})),
      }),
      payload: { snapshot: input.snapshot ?? null },
    });
  }
  return { applicable: true, newlyClosed };
}

interface BettingRules {
  mode: string;
  phase: string;
  budget: number;
  cutoffBps: number;
  stallSeconds: number | null;
}

/**
 * One meter per round run. For points rounds every call is a no-op.
 */
export class BettingMeter {
  private readonly tokens = new Map<
    string,
    { tokens: number; estimated: boolean; state: string }
  >();
  private closed = false;
  private lastActivity = Date.now();

  private constructor(
    private readonly roundId: string,
    private readonly rules: BettingRules,
    private readonly supabase: SupabaseClient,
    modelIds: readonly string[],
  ) {
    for (const id of modelIds)
      this.tokens.set(id, { tokens: 0, estimated: false, state: "generating" });
    this.closed = rules.mode !== "devnet_sol" || rules.phase === "closed";
  }

  static async forRound(
    roundId: string,
    modelIds: readonly string[],
    supabase: SupabaseClient = getServiceRoleSupabase(),
  ): Promise<BettingMeter> {
    const { data, error } = await supabase
      .from("rounds")
      .select(
        "wagering_mode, betting_phase, token_budget_per_model, cutoff_bps, stall_timeout_seconds",
      )
      .eq("id", roundId)
      .maybeSingle();
    if (error || !data)
      throw new InternalError(
        "Failed to read the betting rules",
        error ?? undefined,
      );

    const meter = new BettingMeter(
      roundId,
      {
        mode: data.wagering_mode as string,
        phase: data.betting_phase as string,
        budget: Number(data.token_budget_per_model ?? 0),
        cutoffBps: Number(data.cutoff_bps ?? 7500),
        stallSeconds:
          data.stall_timeout_seconds === null
            ? null
            : Number(data.stall_timeout_seconds),
      },
      supabase,
      modelIds,
    );
    return meter;
  }

  get active(): boolean {
    return !this.closed;
  }

  get thresholdTokens(): number {
    return Math.ceil((this.rules.budget * this.rules.cutoffBps) / 10_000);
  }

  /** Seed from chunks a previous (interrupted) run already stored. */
  seed(modelId: string, tokens: number): void {
    const entry = this.tokens.get(modelId);
    if (entry) entry.tokens += tokens;
  }

  snapshot(): MeterSnapshot {
    return {
      budgetTokens: this.rules.budget,
      thresholdTokens: this.thresholdTokens,
      models: Object.fromEntries(this.tokens),
    };
  }

  /** Must be awaited before the event's output becomes visible. */
  async beforeReveal(event: MeterEvent): Promise<void> {
    this.lastActivity = Date.now();
    const entry = this.tokens.get(event.modelId);
    if (!entry) return;

    if (event.kind === "chunk") {
      const counted = estimateTokens(event.outputTokens, event.chars ?? 0);
      entry.tokens += counted.tokens;
      entry.estimated ||= counted.estimated;
    } else {
      entry.state = event.kind;
    }

    if (this.closed) return;

    let reason: CloseReason | null = null;
    if (event.kind === "failed") reason = "model_failed";
    else if (event.kind === "finished") reason = "model_finished";
    else if (this.rules.budget > 0 && entry.tokens >= this.thresholdTokens)
      reason = "token_threshold";
    else if (event.terminal) reason = "model_finished";

    if (reason) await this.close(reason, event.modelId);
  }

  async close(
    reason: CloseReason,
    modelId: string | null = null,
  ): Promise<void> {
    if (this.closed) return;
    // Mark first so concurrent models do not race a second RPC; the RPC itself
    // is idempotent regardless.
    this.closed = true;
    try {
      await closeBetting({
        roundId: this.roundId,
        reason,
        modelId,
        snapshot: this.snapshot(),
        supabase: this.supabase,
      });
    } catch (error) {
      this.closed = false;
      throw error;
    }
  }

  /** The optional stall safeguard: `true` when it fired. */
  async checkStall(): Promise<boolean> {
    if (this.closed || this.rules.stallSeconds === null) return false;
    if (Date.now() - this.lastActivity < this.rules.stallSeconds * 1000)
      return false;
    await this.close("stall");
    return true;
  }
}
