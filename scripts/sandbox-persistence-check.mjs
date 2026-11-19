/**
 * F13 persistence check — schema contract for sandbox result writes.
 *
 * What this verifies: that the composite keys `persist.ts` upserts on really do
 * make a re-run resume instead of duplicating, and that the columns F13 writes
 * exist and accept the values the runner sends.
 *
 * What this does NOT do: import `apps/web/lib/server/services/evaluation/persist.ts`.
 * Those modules are `server-only` and use the `@/` path alias, and this repo has
 * no JS test runner or bundler configured for them (its tests are SQL scripts
 * pasted into the Supabase editor). The `onConflict` targets below are therefore
 * a deliberate copy — if you change one in `persist.ts`, change it here too.
 *
 * Gated on credentials: with no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY it
 * skips, so `node --test` passes on a bare checkout.
 *
 * Usage: npm run sandbox:check
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(HERE, "..", "apps", "web", ".env.local");

/** Minimal .env parser — the repo has no dotenv dependency. */
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
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(ENV_FILE);

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Mirrors persist.ts. Keep in sync if those change.
const EXECUTION_CONFLICT = "round_id,model_id,run_type,attempt";
const TEST_RESULT_CONFLICT = "execution_id,test_case_id";

const SKIP_REASON =
  "needs SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY";

test(
  "sandbox persistence contract",
  { skip: !SUPABASE_URL || !SERVICE_KEY ? SKIP_REASON : false },
  async (t) => {
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Deterministic, identifiable fixtures so a crashed run is easy to find.
    const suffix = `f13-check-${Date.now()}`;
    const created = {
      modelId: null,
      challengeId: null,
      testCaseIds: [],
      roundId: null,
      executionId: null,
    };

    t.after(async () => {
      // Children first; rounds/challenges cascade but be explicit anyway.
      if (created.executionId) {
        await supabase
          .from("test_results")
          .delete()
          .eq("execution_id", created.executionId);
        await supabase
          .from("model_executions")
          .delete()
          .eq("id", created.executionId);
      }
      if (created.roundId) {
        await supabase.from("rounds").delete().eq("id", created.roundId);
      }
      for (const id of created.testCaseIds) {
        await supabase.from("test_cases").delete().eq("id", id);
      }
      if (created.challengeId) {
        await supabase
          .from("challenges")
          .delete()
          .eq("id", created.challengeId);
      }
      if (created.modelId) {
        await supabase.from("llm_models").delete().eq("id", created.modelId);
      }
    });

    await t.test("creates fixtures", async () => {
      const model = await supabase
        .from("llm_models")
        .insert({
          slug: `${suffix}-model`,
          name: "F13 check model",
          openrouter_model_id: `${suffix}@openrouter`,
        })
        .select("id")
        .single();
      assert.equal(model.error, null, model.error?.message);
      created.modelId = model.data.id;

      const challenge = await supabase
        .from("challenges")
        .insert({
          slug: `${suffix}-challenge`,
          title: "F13 check",
          prompt: "Add two numbers.",
          entry_point: "solve",
          status: "published",
        })
        .select("id")
        .single();
      assert.equal(challenge.error, null, challenge.error?.message);
      created.challengeId = challenge.data.id;

      const cases = await supabase
        .from("test_cases")
        .insert([
          {
            challenge_id: created.challengeId,
            kind: "public",
            ordinal: 1,
            input: "[2,3]",
            expected_output: "5",
          },
          {
            challenge_id: created.challengeId,
            kind: "hidden",
            ordinal: 2,
            input: "[10,5]",
            expected_output: "15",
          },
        ])
        .select("id, ordinal");
      assert.equal(cases.error, null, cases.error?.message);
      created.testCaseIds = cases.data.map((row) => row.id);

      const round = await supabase
        .from("rounds")
        .insert({
          slug: suffix,
          challenge_id: created.challengeId,
          prediction_deadline: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .select("id")
        .single();
      assert.equal(round.error, null, round.error?.message);
      created.roundId = round.data.id;
    });

    await t.test(
      "execution upsert is idempotent on its composite key",
      async () => {
        const row = {
          round_id: created.roundId,
          model_id: created.modelId,
          run_type: "generation",
          attempt: 1,
          openrouter_model_id: `${suffix}@openrouter`,
          config: {},
          status: "running",
          solution_code: "def solve(a,b): return a+b",
          sandbox_image: `test@sha256:${"0".repeat(64)}`,
          harness_protocol: 1,
        };

        const first = await supabase
          .from("model_executions")
          .upsert(row, { onConflict: EXECUTION_CONFLICT })
          .select("id")
          .single();
        assert.equal(first.error, null, first.error?.message);
        created.executionId = first.data.id;

        const second = await supabase
          .from("model_executions")
          .upsert(
            { ...row, status: "succeeded" },
            { onConflict: EXECUTION_CONFLICT },
          )
          .select("id")
          .single();
        assert.equal(second.error, null, second.error?.message);
        assert.equal(second.data.id, first.data.id, "same row must be reused");

        const count = await supabase
          .from("model_executions")
          .select("id", { count: "exact", head: true })
          .eq("round_id", created.roundId)
          .eq("model_id", created.modelId);
        assert.equal(count.count, 1, "no duplicate execution row");

        const status = await supabase
          .from("model_executions")
          .select("status")
          .eq("id", created.executionId)
          .single();
        assert.equal(
          status.data.status,
          "succeeded",
          "upsert applied the update",
        );
      },
    );

    await t.test(
      "test results upsert is idempotent per test case",
      async () => {
        const rows = created.testCaseIds.map((testCaseId, index) => ({
          execution_id: created.executionId,
          test_case_id: testCaseId,
          passed: index === 0,
          stdout: index === 0 ? "5" : "",
          stderr: index === 0 ? "" : "ValueError: boom",
          exit_code: index === 0 ? 0 : 1,
          duration_ms: 100 + index,
        }));

        const first = await supabase
          .from("test_results")
          .upsert(rows, { onConflict: TEST_RESULT_CONFLICT });
        assert.equal(first.error, null, first.error?.message);

        // Re-run with different values: must update in place, not append.
        const second = await supabase.from("test_results").upsert(
          rows.map((row) => ({ ...row, passed: true, duration_ms: 999 })),
          { onConflict: TEST_RESULT_CONFLICT },
        );
        assert.equal(second.error, null, second.error?.message);

        const stored = await supabase
          .from("test_results")
          .select("test_case_id, passed, duration_ms")
          .eq("execution_id", created.executionId);
        assert.equal(stored.error, null, stored.error?.message);
        assert.equal(stored.data.length, 2, "exactly one row per test case");
        assert.ok(
          stored.data.every((row) => row.passed && row.duration_ms === 999),
          "second upsert updated the existing rows",
        );
      },
    );
  },
);
