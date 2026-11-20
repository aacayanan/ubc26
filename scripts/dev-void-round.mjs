/**
 * Void a round that is stuck mid-pipeline.
 *
 * A round that was locked or started but whose models never produced anything
 * (an interrupted dev run, a killed process) sits in RUNNING/RETRYING/EVALUATING
 * forever. The settle job cannot clear it — settlement needs stored verdicts, and
 * there are none — and `listRoundsForPipeline` keeps re-picking it, so a bare job
 * run chases zombies instead of new work.
 *
 * This walks the legal transition path to VOIDED through `transition_round`
 * (service-role only, audited) rather than writing `rounds.status` directly, so
 * the state machine and the audit log stay honest.
 *
 * Usage (with `npm run dev` running is not required — this talks to the DB):
 *   node scripts/dev-void-round.mjs <roundId> [--reason "..."]
 *
 * It refuses a round that has any execution, artifact or stake, because voiding
 * one of those would destroy a real result rather than clear a zombie.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(HERE, "..", "apps", "web", ".env.local");

function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
}

loadEnvFile(ENV_FILE);

const args = process.argv.slice(2);
const roundId = args.find((a) => !a.startsWith("--"));
const reasonIndex = args.indexOf("--reason");
const REASON =
  reasonIndex >= 0
    ? args[reasonIndex + 1]
    : "Stuck mid-pipeline with no executions; voided to clear a zombie round.";

if (!roundId) {
  console.error(
    "usage: node scripts/dev-void-round.mjs <roundId> [--reason ...]",
  );
  process.exit(2);
}

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
  );
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** Refuse to destroy a round that actually did something. */
async function assertEmpty(round) {
  // `rendered_artifacts` has no round_id; it hangs off an execution. The
  // executions count is therefore the real signal, and artifacts are checked
  // only when there is at least one execution to hang them from.
  const [executions, stakes] = await Promise.all([
    db
      .from("model_executions")
      .select("id", { count: "exact", head: true })
      .eq("round_id", roundId),
    db
      .from("predictions")
      .select("id", { count: "exact", head: true })
      .eq("round_id", roundId),
  ]);

  const counts = {
    executions: executions.count ?? 0,
    stakes: stakes.count ?? 0,
  };

  if (counts.executions > 0 || counts.stakes > 0) {
    fail(
      `Round ${round.slug} is not empty (${JSON.stringify(counts)}). ` +
        "Voiding would discard a real result; settle it instead.",
    );
  }
}

async function transition(to, from) {
  const { data, error } = await db.rpc("transition_round", {
    p_round_id: roundId,
    p_to_status: to,
    p_expected_status: from,
    p_reason: REASON,
  });

  if (error) fail(`Could not transition ${from} → ${to}: ${error.message}`);
  return data;
}

async function main() {
  const { data: round, error } = await db
    .from("rounds")
    .select("id, slug, status")
    .eq("id", roundId)
    .maybeSingle();

  if (error) fail(`Could not read the round: ${error.message}`);
  if (!round) fail(`Round ${roundId} does not exist.`);
  if (round.status === "VOIDED") {
    console.log(`${round.slug} is already VOIDED.`);
    return;
  }

  await assertEmpty(round);
  console.log(`Voiding ${round.slug} (${round.id}) from ${round.status}`);

  switch (round.status) {
    case "CREATED":
    case "OPEN":
      await transition("CANCELLED", round.status);
      break;
    case "LOCKED":
      await transition("CANCELLED", round.status);
      break;
    case "RUNNING":
      await transition("EVALUATING", round.status);
      await transition("VOIDED", "EVALUATING");
      break;
    case "RETRYING":
      await transition("EVALUATING", round.status);
      await transition("VOIDED", "EVALUATING");
      break;
    case "EVALUATING":
      await transition("VOIDED", round.status);
      break;
    case "FAILED":
      await transition("CANCELLED", round.status);
      break;
    default:
      fail(
        `${round.slug} is in ${round.status}; there is no void path from it.`,
      );
  }

  const { data: after } = await db
    .from("rounds")
    .select("status")
    .eq("id", roundId)
    .maybeSingle();

  console.log(`✓ ${round.slug} is now ${after?.status}`);
}

await main();
