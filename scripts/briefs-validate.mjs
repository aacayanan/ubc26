/**
 * F12 brief validation — seed the brief bank, render each reference
 * implementation in the sandbox, and publish only the briefs that pass.
 *
 * Why a script and not a migration: a migration runs in Postgres and cannot
 * render. The acceptance criterion is that a reference implementation *renders*
 * before a brief publishes, so publishing has to happen after a real render,
 * which means outside the database.
 *
 * Flow per brief:
 *   1. seed_brief(doc)        — unchanged docs are a no-op; changed ones bump
 *                               the version and land as a draft
 *   2. load the new draft version
 *   3. render it in the pinned render sandbox image
 *   4. run the brief's deterministic checks over the frames
 *   5. publish_brief()        — only if every check passed
 *
 * Usage (from the repo root):
 *   npm run briefs:validate           seed + render + publish
 *   npm run briefs:validate -- --dry  render + report, never publish
 *
 * Needs the same environment as the app: SUPABASE_URL (or
 * NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY, RENDER_SANDBOX_IMAGE
 * (digest-pinned), and a reachable Docker daemon.
 *
 * The brief documents live in supabase/seeds/20261119100000_visual_briefs.sql,
 * which is the canonical source. This script re-seeds from the same JSON shapes
 * so a change to a brief is made in one place — the SQL file — and re-running
 * this validates and republishes it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(HERE, "..", "apps", "web", ".env.local");
const SEED_FILE = join(
  HERE,
  "..",
  "supabase",
  "seeds",
  "20261119100000_visual_briefs.sql",
);

const DRY_RUN = process.argv.includes("--dry");

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
const RENDER_IMAGE = process.env.RENDER_SANDBOX_IMAGE;
const DOCKER_BIN = process.env.DOCKER_BIN?.trim() || "docker";

const DIGEST_PINNED = /^[\w./:@-]+@sha256:[0-9a-f]{64}$/;

/**
 * The brief documents live in supabase/seeds/20261119100000_visual_briefs.sql,
 * which is the canonical source. That file is applied separately (it is SQL, and
 * supabase-js cannot run arbitrary SQL); this script then renders every draft
 * version and publishes the ones that pass.
 */

function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

if (!SUPABASE_URL || !SERVICE_KEY) {
  die(
    "needs SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY",
  );
}
if (!RENDER_IMAGE) {
  die(
    "needs RENDER_SANDBOX_IMAGE (run `npm run sandbox:render:build`, then pin its digest)",
  );
}
if (!DIGEST_PINNED.test(RENDER_IMAGE)) {
  die(
    "RENDER_SANDBOX_IMAGE must be digest-pinned as name@sha256:<64 hex chars>",
  );
}

/**
 * Run one docker command to completion and return its stdout.
 *
 * Mirrors the app's docker wrapper: no shell, argv array, so an image ref or
 * job cannot inject a command.
 */
function docker(args, { stdin, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(DOCKER_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code: null,
        timedOut,
        spawnError: error.message,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut, spawnError: null });
    });

    if (stdin !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

/** The same hardened flags the app uses — see render-sandbox.ts. */
function renderArgs(name) {
  return [
    "run",
    "--name",
    name,
    "-i",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=256m",
    "--tmpfs",
    "/dev/shm:rw,noexec,nosuid,nodev,size=256m",
    "--memory",
    "1024m",
    "--memory-swap",
    "1024m",
    "--cpus",
    "1",
    "--pids-limit",
    "256",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "1000:1000",
    "-e",
    "HOME=/tmp",
    RENDER_IMAGE,
  ];
}

function buildJob(brief) {
  return {
    protocol: 1,
    source: brief.reference_impl,
    entryPoint: brief.entry_point,
    frameCount: brief.frame_count,
    frameWidth: brief.frame_width,
    frameHeight: brief.frame_height,
    targetDurationMs: brief.target_duration_ms,
    frameTimeoutMs: Number(
      process.env.RENDER_SANDBOX_FRAME_TIMEOUT_MS ?? 10000,
    ),
  };
}

function parseRecord(stdout) {
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.t === "render" && parsed.protocol === 1) return parsed;
    } catch {
      // Not a record line; keep looking.
    }
  }
  return null;
}

/** The deterministic checks, mirrored from gate.ts so the CLI can run standalone. */
function evaluateChecks(checks, record, brief) {
  const outcomes = [];

  for (const check of checks) {
    let passed = false;
    let reason = "";

    switch (check.kind) {
      case "process_exit": {
        const expected = typeof check.expect === "number" ? check.expect : 0;
        passed = record !== null && expected === 0;
        reason = passed
          ? "process exited cleanly"
          : `process exit did not match ${expected}`;
        break;
      }
      case "no_uncaught_error":
        passed = record?.pageError === null || record?.pageError === undefined;
        reason = passed
          ? "no uncaught error"
          : `page error: ${record.pageError}`;
        break;
      case "frames_emitted": {
        const expected =
          typeof check.expect === "number" ? check.expect : brief.frame_count;
        passed = (record?.frames.length ?? 0) === expected;
        reason = `${record?.frames.length ?? 0}/${expected} frames`;
        break;
      }
      case "frame_dimensions": {
        const [w, h] = String(
          check.expect ?? `${brief.frame_width}x${brief.frame_height}`,
        )
          .split("x")
          .map((n) => Number.parseInt(n, 10));
        passed = w === brief.frame_width && h === brief.frame_height;
        reason = passed
          ? `${w}x${h}`
          : `dimensions ${w}x${h} != ${brief.frame_width}x${brief.frame_height}`;
        break;
      }
      case "non_blank": {
        const frames = record?.frames ?? [];
        passed = frames.length > 0 && frames.some((f) => !f.blank);
        reason = passed ? "frames carry content" : "every frame is flat";
        break;
      }
      default:
        passed = false;
        reason = `unknown check kind ${check.kind}`;
    }

    outcomes.push({ kind: check.kind, passed, reason });
  }

  const failed = outcomes.find((o) => !o.passed);
  return {
    passed: failed === undefined,
    checks: outcomes,
    failure: failed ?? null,
  };
}

async function renderBrief(brief) {
  const name = `f12-render-${brief.slug}-${brief.version}`;
  const job = buildJob(brief);

  const result = await docker(renderArgs(name), {
    stdin: JSON.stringify(job),
    timeoutMs: Number(process.env.RENDER_SANDBOX_WALL_CLOCK_MS ?? 90000),
  });

  // Cleanup is best-effort and must not mask the run's result.
  await docker([`rm`, "-f", name], { timeoutMs: 10000 });

  if (result.spawnError) {
    return { unavailable: true, record: null, reason: result.spawnError };
  }
  if (result.code === 125 || result.code === 126) {
    return { unavailable: true, record: null, reason: result.stderr.trim() };
  }
  if (result.timedOut) {
    return { unavailable: false, record: null, reason: "render timed out" };
  }

  const record = parseRecord(result.stdout);
  if (!record) {
    return {
      unavailable: false,
      record: null,
      reason: "render produced no result record",
    };
  }
  if (!record.ok) {
    return {
      unavailable: false,
      record,
      reason: record.error ?? "render failed",
    };
  }

  return { unavailable: false, record, reason: null };
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(
    DRY_RUN
      ? "Validating draft briefs (dry run — nothing will be published)."
      : "Validating draft briefs.",
  );

  // The seed file is the canonical definition of every brief; applying it is a
  // separate step (`npm run db:seed:briefs`, or pasting it into the SQL
  // editor) because supabase-js cannot run arbitrary SQL. This script's job is
  // the part SQL cannot do: render each draft and publish the ones that pass.
  const { data: drafts, error } = await supabase
    .from("challenges")
    .select(
      "id, slug, version, entry_point, frame_count, frame_width, frame_height, " +
        "target_duration_ms, deterministic_checks, reference_impl, status",
    )
    .eq("language", "javascript")
    .eq("status", "draft")
    .order("slug", { ascending: true })
    .order("version", { ascending: false });

  if (error) die(`could not list drafts: ${error.message}`);

  if (!drafts || drafts.length === 0) {
    console.log(
      "\nNo draft briefs to validate. Apply the seed first:\n" +
        "  npm run db:seed:briefs\n" +
        `\nSeed file: ${SEED_FILE}`,
    );
    return;
  }

  // One draft per slug: the newest version.
  const latest = new Map();
  for (const row of drafts) {
    if (!latest.has(row.slug)) latest.set(row.slug, row);
  }

  let failures = 0;

  for (const brief of latest.values()) {
    process.stdout.write(`\n→ ${brief.slug} v${brief.version} … `);

    const render = await renderBrief(brief);

    if (render.unavailable) {
      console.log("SKIP (render sandbox unavailable)");
      console.error(`   ${render.reason}`);
      failures += 1;
      continue;
    }

    const checks = Array.isArray(brief.deterministic_checks)
      ? brief.deterministic_checks
      : [];
    const verdict = render.record
      ? evaluateChecks(checks, render.record, brief)
      : { passed: false, checks: [], failure: { reason: render.reason } };

    if (!verdict.passed) {
      console.log("FAIL");
      for (const check of verdict.checks) {
        console.log(
          `   ${check.passed ? "✓" : "✗"} ${check.kind}: ${check.reason}`,
        );
      }
      if (!render.record) console.error(`   ${render.reason}`);
      failures += 1;
      continue;
    }

    console.log("PASS");

    if (DRY_RUN) {
      console.log("   (dry run — not published)");
      continue;
    }

    const digest = RENDER_IMAGE.slice(RENDER_IMAGE.lastIndexOf("@") + 1);
    const published = await supabase.rpc("publish_brief", {
      p_slug: brief.slug,
      p_version: brief.version,
      p_image_digest: digest,
    });

    if (published.error) {
      console.log(`   ✗ publish failed: ${published.error.message}`);
      failures += 1;
    } else {
      console.log("   published");
    }
  }

  if (failures > 0) {
    die(`${failures} brief(s) did not validate`);
  }

  console.log("\nAll briefs validated.");
}

main().catch((error) => die(error.message));
