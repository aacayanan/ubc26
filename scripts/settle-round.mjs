/**
 * Settle a round through the internal job (F18).
 *
 * The job is gated by INTERNAL_JOB_SECRET, which lives in apps/web/.env.local.
 * Reading it here keeps the secret out of your shell history and avoids the
 * quote-juggling of a one-line `curl` with a command substitution inside.
 *
 * Usage (with `npm run dev` running):
 *   node scripts/settle-round.mjs <roundId>
 *   node scripts/settle-round.mjs <roundId> --url http://localhost:3000
 *
 * Prints the job's JSON response and exits non-zero on a non-2xx status.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(ENV_FILE);

const args = process.argv.slice(2);
const roundId = args.find((a) => !a.startsWith("--"));
const urlIndex = args.indexOf("--url");
const baseUrl =
  urlIndex >= 0
    ? args[urlIndex + 1]
    : (process.env.DEV_BASE_URL ?? "http://localhost:3000");

if (!roundId) {
  console.error(
    "usage: node scripts/settle-round.mjs <roundId> [--url http://localhost:3000]",
  );
  process.exit(2);
}

const secret = process.env.INTERNAL_JOB_SECRET;
if (!secret) {
  console.error(`INTERNAL_JOB_SECRET is not set — expected it in ${ENV_FILE}.`);
  process.exit(2);
}

const response = await fetch(`${baseUrl}/api/internal/jobs/settle-rounds`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-internal-job-secret": secret,
  },
  body: JSON.stringify({ roundId }),
});

const text = await response.text();

let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = text;
}

console.log(JSON.stringify(parsed, null, 2));

if (!response.ok) {
  console.error(`\n✗ settlement failed with HTTP ${response.status}`);
  process.exit(1);
}

const round = Array.isArray(parsed?.rounds) ? parsed.rounds[0] : null;
if (round) {
  console.log(
    `\n${round.status}: winner ${round.winnerModelId ?? "—"}, pot ${round.potPoints} pts, ` +
      `${round.stakesSettled} stake(s) settled, ${round.pointsCredited} points credited`,
  );
  if (round.status === "incomplete" || round.status === "retryable") {
    console.log(`Not settled yet — ${round.reason}`);
  }
}
