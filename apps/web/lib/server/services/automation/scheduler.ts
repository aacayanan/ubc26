import "server-only";

import { randomUUID } from "node:crypto";
import { logger } from "@/lib/server/logging/logger";
import {
  drivePipeline,
  driveRounds,
  isClaimConflict,
  logTick,
  type PendingPipeline,
} from "./round-driver";

/**
 * The in-process round scheduler.
 *
 * Started once from `instrumentation.ts` when the Next server boots. It is what
 * makes a round advance on its own: the ante window closes when the clock says
 * so, generation starts, betting closes at the cutoff, rendering and judging
 * follow, then settlement and payouts — with no operator and no terminal.
 *
 * Design constraints, each deliberate:
 *
 *   * **Generation never blocks the clock.** A pipeline run takes minutes. Its
 *     promise is tracked, not awaited, so the next tick can still lock the next
 *     round, settle a finished one and send payouts.
 *   * **One generator per round.** A round already being generated is skipped.
 *     The pipeline additionally claims atomically in the database, so even a
 *     manual `run-rounds` cannot double-generate the same round.
 *   * **Never throw.** A scheduler that dies on the first database hiccup stops
 *     advancing every later round. Failures are logged and retried next tick.
 *   * **Backoff per round.** A round that fails fast (a missing keypair, a
 *     broken model) must not be retried every two seconds.
 *   * **Cheap when idle.** A tick with nothing due is a handful of small reads
 *     and no writes.
 *
 * Single-instance by design: the deploy target is one container that owns the
 * Docker socket. The database claim keeps a second instance correct, but it
 * would duplicate provider spend, so the intended shape is one process.
 */

const DEFAULT_INTERVAL_MS = 2_000;

/** How long a failed round is left alone before another attempt. */
const RETRY_BACKOFF_MS = 30_000;

/**
 * How often the money lane runs. Settlement is a database operation and belongs
 * on every tick; payouts read and write Devnet, so they are paced — the public
 * RPC rate-limits, and a payout that landed needs a confirmation read, not a
 * hammering.
 */
const MONEY_INTERVAL_MS = 10_000;

let lastMoneyAt = 0;

/**
 * How many rounds may generate at once. One, on purpose: each preview and each
 * full render spawns a headless Chromium with its own CPU and memory
 * reservation, and a demo host runs one at a time. It also keeps the provider
 * bill predictable.
 */
const MAX_CONCURRENT_PIPELINES = 1;

interface Backoff {
  failures: number;
  notBefore: number;
}

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
/** Rounds whose generation this process is currently running. */
const generating = new Set<string>();
const backoff = new Map<string, Backoff>();

function intervalMs(): number {
  const raw = Number.parseInt(
    process.env.ROUND_SCHEDULER_INTERVAL_MS ?? "",
    10,
  );
  return Number.isFinite(raw) && raw >= 500 ? raw : DEFAULT_INTERVAL_MS;
}

/** Disabled explicitly by env; the default is on. */
export function schedulerEnabled(): boolean {
  const flag = (process.env.ROUND_SCHEDULER ?? "").trim().toLowerCase();
  return flag !== "off" && flag !== "false" && flag !== "0";
}

function backoffDelay(failures: number): number {
  return RETRY_BACKOFF_MS * Math.min(failures, 10);
}

function noteFailure(roundId: string, now: number): void {
  const previous = backoff.get(roundId);
  const failures = (previous?.failures ?? 0) + 1;
  backoff.set(roundId, {
    failures,
    notBefore: now + backoffDelay(failures),
  });
}

/**
 * Start generation for rounds that are due, in the background.
 *
 * Returns immediately: the caller's tick keeps advancing the clock while these
 * run. A round already generating in this process is skipped; a round that was
 * generating in a process that has since died is picked up because the database
 * still reports it RUNNING.
 */
function launchPendingPipelines(
  pending: PendingPipeline[],
  correlationId: string,
): void {
  const now = Date.now();

  for (const round of pending) {
    if (generating.size >= MAX_CONCURRENT_PIPELINES) break;
    if (generating.has(round.id)) continue;

    const blocked = backoff.get(round.id);
    if (blocked && blocked.notBefore > now) continue;

    generating.add(round.id);
    void drivePipeline(round, correlationId)
      .then((outcome) => {
        if (outcome.ok) {
          // A round that finished but could not be judged (no judge seated, a
          // judge outage) is left RUNNING and would be relaunched on the very
          // next tick. Back it off so a missing judge does not mean a new
          // generation pass every two seconds.
          if (!outcome.result.judged) {
            noteFailure(round.id, Date.now());
          } else {
            backoff.delete(round.id);
          }
          logger.info("automation.pipeline.finished", {
            correlationId,
            roundId: round.id,
            slug: outcome.result.slug,
            judged: outcome.result.judged,
          });
          return;
        }

        // Losing the claim is expected, not a failure: another runner has it.
        if (isClaimConflict(outcome.error)) {
          logger.info("automation.pipeline.claimed", {
            correlationId,
            roundId: round.id,
          });
          return;
        }

        noteFailure(round.id, Date.now());
        logger.warn("automation.pipeline.failed", {
          correlationId,
          roundId: round.id,
          message:
            outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error),
        });
      })
      .finally(() => {
        generating.delete(round.id);
      });
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  const correlationId = `scheduler-${randomUUID()}`;

  try {
    const now = Date.now();
    const runMoney = now - lastMoneyAt >= MONEY_INTERVAL_MS;
    if (runMoney) lastMoneyAt = now;

    const summary = await driveRounds({ correlationId, runMoney });
    logTick(summary, correlationId);

    for (const error of summary.errors) {
      if (error.roundId) noteFailure(error.roundId, Date.now());
    }

    launchPendingPipelines(summary.pending, correlationId);
  } catch (error) {
    logger.error("automation.tick.crashed", {
      correlationId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  } finally {
    ticking = false;
  }
}

/**
 * Start the scheduler. Idempotent: a second call (a dev-server reload, two
 * imports) does nothing.
 */
export function startRoundScheduler(): void {
  if (started) return;
  if (!schedulerEnabled()) {
    logger.info("automation.scheduler.disabled", {});
    return;
  }

  started = true;
  const every = intervalMs();
  logger.info("automation.scheduler.started", { intervalMs: every });

  void tick();
  timer = setInterval(() => void tick(), every);
  // The HTTP server keeps the process alive; the scheduler alone should not.
  timer.unref?.();
}

/** Stop the scheduler (tests, graceful shutdown). */
export function stopRoundScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
  ticking = false;
}

/** Test seam: the rounds this process is currently generating. */
export function generatingRounds(): ReadonlySet<string> {
  return generating;
}
