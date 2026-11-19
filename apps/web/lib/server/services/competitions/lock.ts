import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoundStatus } from "@ai-showdown/shared";
import { InternalError, ValidationError } from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";

/**
 * Deadline locking for competition rounds (F11).
 *
 * The transition itself is `public.lock_due_rounds` (migration 20261118101400):
 * one transaction selects due OPEN rounds with `for update skip locked` and
 * calls `transition_round` for each. That RPC already treats a repeat of the
 * target status as a no-op, which is what makes this job safe to run on a
 * schedule, on a manual trigger, and from two instances at once.
 *
 * This module owns the *policy* — batch size, logging, and the error surface —
 * and the query the next pipeline stage uses to resume from LOCKED.
 */

/** Upper bound on rows one invocation may lock. Keeps a stale cron tick short. */
export const MAX_LOCK_BATCH = 1000;

export function assertLockLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LOCK_BATCH) {
    throw new ValidationError(
      `limit must be an integer between 1 and ${MAX_LOCK_BATCH}`,
      { limit },
    );
  }
}

export interface LockDueRoundsInput {
  /**
   * Evaluation clock. Defaults to the database's `now()`. Passing a value is a
   * backfill/testing affordance — production calls leave it unset so the job
   * cannot depend on the app host's clock being correct.
   */
  now?: string;
  limit?: number;
  reason?: string;
  correlationId: string;
  supabase?: SupabaseClient;
}

export interface LockedRound {
  roundId: string;
  previousStatus: RoundStatus;
  newStatus: RoundStatus;
}

export interface LockDueRoundsResult {
  /** Rounds this invocation actually moved to LOCKED. */
  locked: LockedRound[];
  /**
   * True when the batch filled up, meaning more rounds were due than `limit`.
   * The caller should run again rather than wait for the next tick.
   */
  hasMore: boolean;
}

interface LockDueRoundRow {
  round_id: string;
  previous_status: RoundStatus;
  new_status: RoundStatus;
}

/**
 * Transition every OPEN round whose prediction deadline has passed to LOCKED.
 *
 * Never throws for "nothing to do": an empty result is the normal steady state.
 * A round already LOCKED by an overlapping run is invisible to this query
 * (it is no longer OPEN), so two runs cannot both claim the same round.
 */
export async function lockDueRounds(
  input: LockDueRoundsInput,
): Promise<LockDueRoundsResult> {
  const { correlationId } = input;
  const limit = input.limit ?? MAX_LOCK_BATCH;

  assertLockLimit(limit);

  if (input.now !== undefined && Number.isNaN(Date.parse(input.now))) {
    throw new ValidationError("now must be an ISO-8601 timestamp", {
      now: input.now,
    });
  }

  const supabase = input.supabase ?? getServiceRoleSupabase();

  // Omit `p_now` entirely when no override is given so the SQL default
  // (`now()`, the database's clock) applies. Sending an explicit null would
  // reach the function's not-null check instead.
  const { data, error } = await supabase.rpc("lock_due_rounds", {
    ...(input.now !== undefined ? { p_now: input.now } : {}),
    p_limit: limit,
    ...(input.reason ? { p_reason: input.reason } : {}),
  });

  if (error) {
    throw new InternalError("Failed to lock due rounds", error);
  }

  const rows = (data ?? []) as LockDueRoundRow[];
  const locked: LockedRound[] = rows.map((row) => ({
    roundId: row.round_id,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
  }));

  if (locked.length > 0) {
    logger.info("rounds.locked", {
      correlationId,
      count: locked.length,
      // Round ids are public (they appear in URLs); the deadline reason is not
      // user data either. Batch them so one tick is one log line.
      roundIds: locked.map((round) => round.roundId),
    });
  }

  return { locked, hasMore: locked.length >= limit };
}

interface RoundRow {
  id: string;
  slug: string;
  status: RoundStatus;
  prediction_deadline: string;
  locked_at: string | null;
}

export interface RoundAwaitingRun {
  id: string;
  slug: string;
  status: RoundStatus;
  predictionDeadline: string;
  lockedAt: string | null;
}

/**
 * Rounds the pipeline may pick up next (F17).
 *
 * After a crash the next stage must not depend on an in-memory list of "rounds
 * I just locked". It asks the database instead: any LOCKED round is fair game,
 * and processing is idempotent at the execution layer (`model_executions`'
 * unique key), so re-picking a round that was half-processed resumes rather
 * than duplicates. Ordering by `locked_at` drains the backlog oldest-first.
 */
export async function listRoundsAwaitingRun(
  options: {
    limit?: number;
    supabase?: SupabaseClient;
  } = {},
): Promise<RoundAwaitingRun[]> {
  const limit = options.limit ?? 50;

  assertLockLimit(limit);

  const supabase = options.supabase ?? getServiceRoleSupabase();

  const { data, error } = await supabase
    .from("rounds")
    .select("id, slug, status, prediction_deadline, locked_at")
    .eq("status", "LOCKED")
    .order("locked_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(limit);

  if (error) {
    throw new InternalError("Failed to list rounds awaiting evaluation", error);
  }

  return ((data ?? []) as RoundRow[]).map((row) => ({
    id: row.id,
    slug: row.slug,
    status: row.status,
    predictionDeadline: row.prediction_deadline,
    lockedAt: row.locked_at,
  }));
}
