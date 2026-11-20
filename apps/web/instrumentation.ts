/**
 * Next's server startup hook (instrumentation).
 *
 * Starting the round scheduler here — and nowhere else — is what makes a round
 * advance without an operator. The app has no cron container and no external
 * scheduler; a round's deadline, generation, judging, settlement and payouts all
 * happen because this process is alive.
 *
 * `register` runs once per server process, after the environment is loaded and
 * before the first request. It also runs for the Node and Edge runtimes, so the
 * body is guarded: the scheduler needs Postgres, Docker and Node APIs, and must
 * never be pulled into an Edge bundle.
 *
 * Disable with `ROUND_SCHEDULER=off` — for a second instance that should only
 * serve traffic, or for a scripted run that drives the jobs by hand.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Without a service-role key every tick would fail its first read. A
  // checkout with no database configured should be quiet, not warn every 2s.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;

  const { startRoundScheduler } =
    await import("@/lib/server/services/automation/scheduler");
  startRoundScheduler();
}
