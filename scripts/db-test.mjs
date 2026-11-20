/**
 * Local SQL test runner (F18 and the rest of the assertion suite).
 *
 * Why this exists: every `supabase/tests/*.sql` file is written to be pasted
 * into the hosted SQL editor, and there was no way to run them here — no local
 * Postgres, no script, and the F18 settlement SQL was therefore unverified. This
 * makes them runnable, reproducibly and in CI, against a throwaway container.
 *
 * What it does, in order, for each invocation:
 *   1. starts a disposable Postgres container (default: the official `postgres`
 *      image, no volume — nothing survives the run);
 *   2. applies `scripts/db-local/bootstrap.sql`, which adds the Supabase-shaped
 *      pieces the schema expects (roles, `auth.users`, `auth.uid()`, default
 *      grants) to a vanilla Postgres;
 *   3. applies every `supabase/migrations/*.sql` in filename order — the same
 *      order `supabase db push` uses;
 *   4. runs every `supabase/tests/*.sql` (or the ones named), each in its own
 *      `psql` process so one failure does not abort the rest, and reports pass or
 *      fail per file.
 *
 * It deliberately does NOT use the Supabase CLI's `db start` — that pulls the
 * whole Supabase stack (GoTrue, Kong, Studio) which the SQL tests do not need.
 * The bootstrap is the honest, minimal shim; its limits are stated in that file.
 *
 * Usage:
 *   node scripts/db-test.mjs                 # all migrations + all tests
 *   node scripts/db-test.mjs f18_settlement   # only tests whose name matches
 *   node scripts/db-test.mjs --keep           # leave the container for inspection
 *   node scripts/db-test.mjs --migrations-only
 *
 * Requires Docker running. Exits non-zero if any test file fails.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MIGRATIONS_DIR =
  process.env.DB_TEST_MIGRATIONS_DIR ?? join(ROOT, "supabase", "migrations");
const TESTS_DIR = join(ROOT, "supabase", "tests");
const BOOTSTRAP = join(HERE, "db-local", "bootstrap.sql");

const IMAGE = process.env.DB_TEST_IMAGE ?? "postgres:17-alpine";
const PG_USER = "postgres";
const PG_DB = "postgres";
const CONTAINER = `ai-showdown-dbtest-${process.pid}`;

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const MIGRATIONS_ONLY = args.includes("--migrations-only");
const TWICE = args.includes("--twice");
const filters = args.filter((a) => !a.startsWith("--"));

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------

function docker(runArgs, { capture = true, allowFailure = false } = {}) {
  const result = spawnSync("docker", runArgs, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    throw new Error(`could not run docker: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `docker ${runArgs.slice(0, 2).join(" ")} failed (exit ${result.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  return result;
}

function assertDockerAvailable() {
  const probe = docker(["info"], { allowFailure: true });
  if (probe.status !== 0) {
    throw new Error(
      "Docker is not available. Start Docker Desktop (or set DB_TEST_IMAGE to an image on a reachable daemon) and re-run.",
    );
  }
}

/** Poll `pg_isready` until the server accepts connections, or time out. */
function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const probe = docker(
      ["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", PG_USER, "-d", PG_DB],
      { allowFailure: true },
    );
    if (probe.status === 0) return;
    spawnSync("sleep", ["0.5"]);
  }
  throw new Error("Postgres did not become ready within 60s");
}

/**
 * Run a SQL file with psql inside the container.
 *
 * The file is streamed on stdin rather than mounted: a bind mount of a
 * host directory is the kind of thing that behaves differently on macOS/Colima
 * and in CI, and the files are small.
 */
function runSqlFile(path, { stopOnError = true } = {}) {
  const sql = readFileSync(path, "utf8");
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-X",
      "-q",
      "-U",
      PG_USER,
      "-d",
      PG_DB,
    ],
    { input: sql, encoding: "utf8" },
  );

  if (result.error) {
    throw new Error(`failed to invoke psql: ${result.error.message}`);
  }

  const ok = result.status === 0;
  if (!ok && stopOnError) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(detail || `psql exited ${result.status}`);
  }

  return { ok, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function listSql(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  assertDockerAvailable();

  const migrations = listSql(MIGRATIONS_DIR);
  const allTests = listSql(TESTS_DIR);
  const tests = filters.length
    ? allTests.filter((name) => filters.some((f) => name.includes(f)))
    : allTests;

  if (tests.length === 0 && !MIGRATIONS_ONLY) {
    console.error(
      `No test files matched ${JSON.stringify(filters)} in ${TESTS_DIR}`,
    );
    process.exit(2);
  }

  console.log(`▶ starting ${IMAGE} as ${CONTAINER}`);
  docker(
    [
      "run",
      "--detach",
      "--name",
      CONTAINER,
      "-e",
      `POSTGRES_PASSWORD=${PG_USER}`,
      "-e",
      `POSTGRES_DB=${PG_DB}`,
      IMAGE,
    ],
    { capture: true },
  );

  let exitCode = 0;

  try {
    waitForPostgres();

    console.log("▶ bootstrap (roles, auth schema, default grants)");
    runSqlFile(BOOTSTRAP);

    console.log(`▶ applying ${migrations.length} migration(s)`);
    for (const name of migrations) {
      const started = Date.now();
      runSqlFile(join(MIGRATIONS_DIR, name));
      console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
    }

    // The hosted project has drifted from migration history before, so the
    // migrations are written to be re-runnable. `--twice` proves it. When a
    // filter is given it scopes BOTH passes after the initial full apply: the
    // earliest migrations (init) use plain `create type` and are deliberately
    // not idempotent, so checking the ones you changed is the useful mode.
    if (TWICE) {
      const reapply = filters.length
        ? migrations.filter((name) => filters.some((f) => name.includes(f)))
        : migrations;

      console.log(`▶ re-applying ${reapply.length} migration(s) (idempotency)`);
      const failures = [];
      for (const name of reapply) {
        try {
          runSqlFile(join(MIGRATIONS_DIR, name));
          console.log(`  ✓ ${name}`);
        } catch (error) {
          console.log(`  ✗ ${name}`);
          failures.push({
            name,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (failures.length > 0) {
        for (const failure of failures) {
          console.error(
            `\n✗ ${failure.name} is not idempotent:\n  ${failure.detail}`,
          );
        }
        throw new Error(
          `${failures.length} migration(s) failed the second pass`,
        );
      }
    }

    if (MIGRATIONS_ONLY) {
      console.log("\n✓ all migrations applied cleanly");
      return;
    }

    console.log(`\n▶ running ${tests.length} test file(s)`);
    const failures = [];
    for (const name of tests) {
      // Each test file is self-contained (begin … rollback) and runs in its own
      // psql process, so a FAIL in one does not mask the others.
      const { ok, stdout, stderr } = runSqlFile(join(TESTS_DIR, name), {
        stopOnError: false,
      });
      const output = `${stdout}\n${stderr}`.trim();

      if (ok && /all assertions passed/.test(output)) {
        console.log(`  ✓ ${name}`);
      } else {
        console.log(`  ✗ ${name}`);
        if (output) {
          for (const line of output.split("\n")) console.log(`      ${line}`);
        }
        failures.push(name);
      }
    }

    if (failures.length > 0) {
      console.error(`\n✗ ${failures.length} test file(s) failed:`);
      for (const name of failures) console.error(`    - ${name}`);
      exitCode = 1;
    } else {
      console.log("\n✓ all SQL tests passed");
    }
  } catch (error) {
    console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
    exitCode = 1;
  } finally {
    if (KEEP) {
      console.log(
        `\n• container ${CONTAINER} left running. Inspect with:\n    docker exec -it ${CONTAINER} psql -U ${PG_USER} -d ${PG_DB}\n  Remove with:\n    docker rm -f ${CONTAINER}`,
      );
    } else {
      docker(["rm", "-f", CONTAINER], { allowFailure: true });
    }
  }

  process.exit(exitCode);
}

main();
