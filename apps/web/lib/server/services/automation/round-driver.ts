import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoundStatus } from "@ai-showdown/shared";
import { ConflictError } from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { lockDueRounds } from "@/lib/server/services/competitions/lock";
import {
  listRoundsForPipeline,
  runRoundPipeline,
  type RunRoundPipelineResult,
} from "@/lib/server/services/pipeline/run-round";
import {
  listRoundsAwaitingSettlement,
  settleRound,
} from "@/lib/server/services/scoring/settlement";
import { processPayouts } from "@/lib/server/services/wagering/payouts";
import { reconcileSubmittedWagers } from "@/lib/server/services/wagering/wagers";

/**
 * The round driver — advances every round as far as it can go.
 *
 * Why this exists: the pipeline stages are exposed as internal job endpoints
 * (`lock-rounds`, `run-rounds`, `settle-rounds`, `sol`), and for a long time
 * *nothing called them*. A round whose ante deadline passed stayed `OPEN` until
 * an operator curled the endpoint, so "the timer ran out and nothing happened"
 * was not a timing bug but a missing trigger. A demo cannot depend on a human
 * with a terminal.
 *
 * One pass does, in order:
 *
 *   1. lock every round whose ante deadline has passed,
 *   2. settle every round that reached `EVALUATING`,
 *   3. send queued SOL payouts and resolve any wager still confirming.
 *
 * Generation is separate (`launchPendingPipelines`) because it takes minutes and
 * must not hold up the cheap stages above: a round that is generating must not
 * delay the lock of the next round or the settlement of another.
 *
 * Every stage is independently idempotent — that is what makes a crash between
 * stages safe and a repeated pass cheap. None of them throws: one round failing
 * must not stop the next one being driven, and a scheduler that dies on the
 * first error is worse than one that logs and retries.
 */

/** A round the pipeline could start on now. */
export interface PendingPipeline {
  id: string;
  slug: string;
  status: RoundStatus;
}

export interface DriverSummary {
  locked: number;
  settled: number;
  payouts: number;
  reconciles: number;
  /** One line per stage failure, so a stuck round is visible without logs. */
  errors: Array<{ stage: string; roundId?: string; message: string }>;
}

export interface DriveInput {
  correlationId: string;
  /** Injectable for tests; defaults to the service-role client. */
  supabase?: SupabaseClient;
  /**
   * Run the money lane this pass. The scheduler sets this on a slower cadence:
   * settlement and the clock are cheap database work, but resolving in-flight
   * payouts talks to Devnet and must not hit a public RPC every two seconds.
   */
  runMoney?: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The cheap stages, run every tick. Returns the rounds the caller may now drive
 * through generation. Never throws.
 */
export async function driveRounds(input: DriveInput): Promise<
  DriverSummary & {
    pending: PendingPipeline[];
    settledRounds: Array<{ roundId: string; slug: string; result: string }>;
  }
> {
  const { correlationId } = input;
  const supabase = input.supabase ?? getServiceRoleSupabase();
  const errors: DriverSummary["errors"] = [];
  const settledRounds: Array<{
    roundId: string;
    slug: string;
    result: string;
  }> = [];
  let locked = 0;
  let settled = 0;
  let payouts = 0;
  let reconciles = 0;

  // 1. Close the ante window. `lock_due_rounds` is the same transaction F11
  //    used; it returns nothing when no round is due, which is the steady state.
  try {
    const result = await lockDueRounds({ correlationId, supabase });
    locked = result.locked.length;
  } catch (error) {
    errors.push({ stage: "lock", message: messageOf(error) });
  }

  // 2. Settle. A round reaches EVALUATING only when every verdict it can have
  //    is stored, so this is the first moment an outcome is decidable.
  let awaiting: Array<{ id: string; slug: string }> = [];
  try {
    awaiting = await listRoundsAwaitingSettlement({ supabase });
  } catch (error) {
    errors.push({ stage: "list-settle", message: messageOf(error) });
  }

  for (const round of awaiting) {
    try {
      const result = await settleRound({ roundId: round.id, correlationId });
      if (result.status === "settled" || result.status === "voided") {
        settled += 1;
        settledRounds.push({
          roundId: round.id,
          slug: round.slug,
          result: result.status,
        });
      }
    } catch (error) {
      // "Wagers still confirming on Devnet" is the normal state for a moment
      // after a close; it resolves on a later tick. Recording it as an error
      // would warn every two seconds and bury the failures that matter.
      if (
        error instanceof ConflictError &&
        /still confirming/i.test(error.message)
      ) {
        continue;
      }
      errors.push({
        stage: "settle",
        roundId: round.id,
        message: messageOf(error),
      });
    }
  }

  // 3. The money. Reconcile first so a wager that landed late is counted before
  //    its round's pool is finalised; then send what settlement queued.
  if (input.runMoney) {
    try {
      const reconciled = await reconcileSubmittedWagers();
      reconciles = reconciled.resolved;
    } catch (error) {
      errors.push({ stage: "reconcile", message: messageOf(error) });
    }

    try {
      const result = await processPayouts();
      payouts = result.confirmed;
    } catch (error) {
      // A missing treasury keypair and an empty queue both land here; neither
      // should stop the next tick.
      errors.push({ stage: "payouts", message: messageOf(error) });
    }
  }

  // 4. What generation can start on next. EVALUATING is excluded: its verdicts
  //    are already stored, and re-running the generator would re-spend provider
  //    calls to reproduce them.
  let pending: PendingPipeline[] = [];
  try {
    const runnable = await listRoundsForPipeline({ supabase });
    pending = runnable.filter((round) => round.status !== "EVALUATING");
  } catch (error) {
    errors.push({ stage: "list-runnable", message: messageOf(error) });
  }

  return {
    locked,
    settled,
    payouts,
    reconciles,
    errors,
    pending,
    settledRounds,
  };
}

/** True when the error means another runner already claimed this round. */
export function isClaimConflict(error: unknown): boolean {
  return (
    error instanceof ConflictError &&
    /claimed|changed concurrently/i.test(error.message)
  );
}

/**
 * Drive one round through generation, render, gate and judge.
 *
 * The claim is atomic inside the pipeline (`transition_round` with an expected
 * status), so two runners cannot both generate the same round: the loser sees a
 * conflict and stops before spending anything.
 */
export async function drivePipeline(
  round: PendingPipeline,
  correlationId: string,
  options: { supabase?: SupabaseClient } = {},
): Promise<
  { ok: true; result: RunRoundPipelineResult } | { ok: false; error: unknown }
> {
  try {
    const result = await runRoundPipeline({
      roundId: round.id,
      correlationId,
      ...(options.supabase ? { supabase: options.supabase } : {}),
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}

/** One structured log line per busy tick; silent when idle. */
export function logTick(
  summary: DriverSummary & { pending: PendingPipeline[] },
  correlationId: string,
): void {
  const busy =
    summary.locked > 0 ||
    summary.settled > 0 ||
    summary.payouts > 0 ||
    summary.reconciles > 0;

  if (busy) {
    logger.info("automation.tick", {
      correlationId,
      locked: summary.locked,
      settled: summary.settled,
      payouts: summary.payouts,
      reconciles: summary.reconciles,
    });
  }

  for (const error of summary.errors) {
    logger.warn("automation.tick.failed", {
      correlationId,
      stage: error.stage,
      roundId: error.roundId,
      message: error.message,
    });
  }
}
