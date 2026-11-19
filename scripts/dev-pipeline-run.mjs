/**
 * F17 manual test driver.
 *
 * The pipeline has no UI trigger yet (that is F19/F27), so this script does the
 * click-work a viewer surface would: seat the judge, open a round with the real
 * competitor lineup, lock it, and fire the internal job that runs the pipeline.
 * Afterwards it prints the watcher URL.
 *
 * Usage (from the repo root, with `npm run dev` already running):
 *   node scripts/dev-pipeline-run.mjs              seat, create, lock, run
 *   node scripts/dev-pipeline-run.mjs --prepare    stop before firing the job
 *   node scripts/dev-pipeline-run.mjs --round <id> run an existing round
 *
 * Preconditions it checks rather than assumes:
 *   * the F17 migration is applied (generation_chunks exists);
 *   * a JavaScript brief is *published* — a round cannot be opened against a
 *     draft, and publishing one is `npm run briefs:validate`'s job because it
 *     has to render the reference implementation first;
 *   * RENDER_SANDBOX_IMAGE is digest-pinned and INTERNAL_JOB_SECRET is set.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(HERE, "..", "apps", "web", ".env.local");
const BASE_URL = process.env.DEV_BASE_URL ?? "http://localhost:3000";

const PREPARE_ONLY = process.argv.includes("--prepare");
// Stop after creating the round but before locking it, so the staking window is
// open and a real account can stake through the UI (F18's funded gate). Then
// `--round <id>` locks nothing — `--lock <id>` does.
const OPEN_ONLY = process.argv.includes("--open");
const LOCK_ARG = (() => {
  const index = process.argv.indexOf("--lock");
  return index >= 0 ? process.argv[index + 1] : null;
})();
const ROUND_ARG = (() => {
  const index = process.argv.indexOf("--round");
  return index >= 0 ? process.argv[index + 1] : null;
})();

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

function fail(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

loadEnvFile(ENV_FILE);

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JOB_SECRET = process.env.INTERNAL_JOB_SECRET;
const SANDBOX_IMAGE = process.env.RENDER_SANDBOX_IMAGE;

if (!SUPABASE_URL || !SERVICE_KEY) {
  fail("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

if (!SANDBOX_IMAGE || !/@sha256:[0-9a-f]{64}$/.test(SANDBOX_IMAGE)) {
  fail(
    "RENDER_SANDBOX_IMAGE must be digest-pinned.",
    "Get the digest with: docker inspect --format '{{index .RepoDigests 0}}' ai-showdown-render:chromium",
  );
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function assertMigrated() {
  const { error } = await db.from("generation_chunks").select("id").limit(1);
  if (error) {
    fail(
      "The F17 migration is not applied to this database.",
      "Push it first: npm run db:push  (or paste supabase/migrations/20261119000700_f17_chunked_pipeline.sql into the SQL editor).",
    );
  }
}

/** Seat exactly one judge; the roster otherwise stays competitors. */
async function seatJudge() {
  const { error } = await db
    .from("llm_models")
    .update({ role: "judge", is_active: true })
    .eq("slug", "judge");

  if (error) fail(`Could not seat the judge: ${error.message}`);

  await db
    .from("llm_models")
    .update({ role: "competitor" })
    .neq("slug", "judge");
}

async function pickBrief() {
  const { data, error } = await db
    .from("challenges")
    .select("id, slug, version")
    .eq("language", "javascript")
    .eq("status", "published")
    .order("slug")
    .limit(1);

  if (error) fail(`Could not read briefs: ${error.message}`);

  if (!data || data.length === 0) {
    fail(
      "No published JavaScript brief. A round cannot open against a draft.",
      "Run `npm run briefs:validate` first — it renders the reference impl and publishes it.",
    );
  }

  return data[0];
}

async function pickLineup() {
  const { data, error } = await db
    .from("llm_models")
    .select("id, slug, openrouter_model_id")
    .eq("role", "competitor")
    .eq("is_active", true)
    .order("sort_order")
    .limit(3);

  if (error) fail(`Could not read the lineup: ${error.message}`);

  const real = (data ?? []).filter(
    (model) => !model.openrouter_model_id.startsWith("demo/"),
  );

  if (real.length < 2) {
    fail(
      "Fewer than two real competitor models are active.",
      "The demo/gpt-style rows are placeholders and will fail at generation.",
    );
  }

  return real;
}

async function pickActor() {
  const { data, error } = await db.from("users").select("id").limit(1);
  if (error) fail(`Could not read users: ${error.message}`);
  if (!data || data.length === 0) {
    fail(
      "No users row to attribute the round to.",
      "Sign in once, then retry.",
    );
  }
  return data[0].id;
}

async function createLockedRound(brief, lineup, actorId) {
  const slug = `dev-${new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14)}`;
  const opensAt = new Date(Date.now() - 1000).toISOString();
  // A long-ish window so a human can actually stake through the UI; the normal
  // path locks immediately and never needs it.
  const deadline = new Date(
    Date.now() + (OPEN_ONLY ? 30 : 5) * 60 * 1000,
  ).toISOString();

  const { data: round, error } = await db.rpc("create_competition", {
    p_slug: slug,
    p_challenge_id: brief.id,
    p_model_ids: lineup.map((model) => model.id),
    p_prediction_opens_at: opensAt,
    p_prediction_deadline: deadline,
    p_created_by: actorId,
  });

  if (error) fail(`Could not create the round: ${error.message}`);

  // `--open` stops here: the round stays OPEN so a real account can stake.
  if (OPEN_ONLY) return round;

  const { error: lockError } = await db.rpc("transition_round", {
    p_round_id: round.id,
    p_to_status: "LOCKED",
    p_reason: "dev pipeline run",
    p_actor_id: actorId,
  });

  if (lockError) fail(`Could not lock the round: ${lockError.message}`);

  return round;
}

/** Lock an OPEN round so the pipeline may run (used after staking via the UI). */
async function lockRound(roundId) {
  const { data: actorId } = await db
    .from("users")
    .select("id")
    .limit(1)
    .maybeSingle();

  const { error } = await db.rpc("transition_round", {
    p_round_id: roundId,
    p_to_status: "LOCKED",
    p_reason: "dev pipeline run",
    ...(actorId?.id ? { p_actor_id: actorId.id } : {}),
  });

  if (error) fail(`Could not lock the round: ${error.message}`);
}

async function fireJob(roundId) {
  if (!JOB_SECRET) {
    fail(
      "INTERNAL_JOB_SECRET is not set, so the job route will reject the call.",
      "Add INTERNAL_JOB_SECRET=<any long random string> to apps/web/.env.local and restart the dev server.",
    );
  }

  console.log(`\n→ POST ${BASE_URL}/api/internal/jobs/run-rounds`);
  console.log(
    "  (this generates, renders and judges — it can take a minute)\n",
  );

  let response;
  try {
    response = await fetch(`${BASE_URL}/api/internal/jobs/run-rounds`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-job-secret": JOB_SECRET,
      },
      body: JSON.stringify({ roundId }),
    });
  } catch (cause) {
    fail(
      `Could not reach ${BASE_URL}.`,
      "Is `npm run dev` running? " +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    fail(
      `The job returned ${response.status}: ${
        body?.error?.message ?? "no message"
      }`,
    );
  }

  console.log(JSON.stringify(body, null, 2));
}

async function main() {
  await assertMigrated();
  await seatJudge();

  // Lock an existing OPEN round (the staking window has closed by then) and run.
  if (LOCK_ARG) {
    await lockRound(LOCK_ARG);
    console.log(`Locked ${LOCK_ARG}`);
    if (!PREPARE_ONLY) await fireJob(LOCK_ARG);
    console.log(`\nWatch: ${BASE_URL}/dev/pipeline/${LOCK_ARG}`);
    return;
  }

  if (ROUND_ARG) {
    console.log(`Using round ${ROUND_ARG}`);
    if (!PREPARE_ONLY) await fireJob(ROUND_ARG);
    console.log(`\nWatch: ${BASE_URL}/dev/pipeline/${ROUND_ARG}`);
    return;
  }

  const brief = await pickBrief();
  const lineup = await pickLineup();
  const actorId = await pickActor();

  console.log(`Brief:  ${brief.slug} v${brief.version}`);
  console.log(`Lineup: ${lineup.map((model) => model.slug).join(", ")}`);

  const round = await createLockedRound(brief, lineup, actorId);

  if (OPEN_ONLY) {
    console.log(`Round:  ${round.slug} (${round.id}) — OPEN`);
    console.log(
      `\nStake now:  ${BASE_URL}/competitions/${round.id}` +
        `\nThen run:   node scripts/dev-pipeline-run.mjs --lock ${round.id}`,
    );
    return;
  }

  console.log(`Round:  ${round.slug} (${round.id}) — LOCKED`);

  if (!PREPARE_ONLY) await fireJob(round.id);

  console.log(`\nWatch: ${BASE_URL}/dev/pipeline/${round.id}`);
}

await main();
