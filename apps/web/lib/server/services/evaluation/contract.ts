import "server-only";

import {
  SANDBOX_PROTOCOL_VERSION,
  type ExecutionRunType,
  type SandboxRecord,
  type SandboxTestRecord,
} from "@ai-showdown/shared";
import { ValidationError } from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";

/**
 * The host-side trust boundary (F13).
 *
 * Everything the container sends back passes through `parseResultStream`, and
 * nothing the container says about correctness is believed: records carry the
 * solution's *value*, and `compare.ts` decides `passed` on this side. That is
 * what makes a forged record pointless — the worst a solution can do is
 * substitute its own answer.
 *
 * Expected answers are never included in a job. A child can read anything the
 * harness writes to /tmp (verified during design), so sending `expected_output`
 * into the container would hand every solution the answer key.
 */

/** A test as the host knows it, including the answer it must not share. */
export interface EvaluationTestCase {
  id: string;
  ordinal: number;
  input: string;
  expectedOutput: string;
  timeoutMs: number;
}

/** A test as the container sees it: arguments and a budget, no answer. */
export interface SandboxJobTest {
  ordinal: number;
  args: unknown[];
  timeoutMs: number;
}

export interface SandboxJob {
  protocol: typeof SANDBOX_PROTOCOL_VERSION;
  source: string;
  entryPoint: string;
  runType: ExecutionRunType;
  tests: SandboxJobTest[];
}

export interface SandboxJobLimits {
  maxTests: number;
  maxSourceChars: number;
  maxTimeoutMs: number;
}

export const DEFAULT_JOB_LIMITS: SandboxJobLimits = {
  maxTests: 50,
  maxSourceChars: 64 * 1024,
  maxTimeoutMs: 30_000,
};

// No leading underscore: blocks `__import__` / `__dict__` attribute poking at
// the call site. Mirrors the challenges_entry_point_format check constraint.
const ENTRY_POINT_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Parse a test case's `input` as a JSON array of positional arguments.
 *
 * `test_cases.input` is `not null default ''`, so a seeded row that never set
 * it arrives as an empty string. Treat that as "no arguments" rather than
 * failing the whole run, and log it so a bad seed is visible.
 */
export function parseTestArguments(
  input: string,
  ordinal: number,
  correlationId: string,
): unknown[] {
  const text = input.trim();
  if (text === "") {
    logger.warn("sandbox.job.input_defaulted", { correlationId, ordinal });
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError(
      `Test case ${ordinal} has input that is not valid JSON`,
      { ordinal },
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ValidationError(
      `Test case ${ordinal} input must be a JSON array of arguments`,
      { ordinal },
    );
  }

  return parsed;
}

/**
 * Parse `test_cases.expected_output` as a JSON value.
 *
 * The column is unconstrained `text` and existing fixtures hold plain words
 * ('ok', 'secret'). Rather than break every seeded challenge, unparseable text
 * is read as a JSON string literal and logged — a real seed bug shows up in the
 * logs instead of aborting the run.
 */
export function parseExpectedOutput(
  text: string,
  ordinal: number,
  correlationId: string,
): unknown {
  try {
    return JSON.parse(text);
  } catch {
    logger.warn("sandbox.expected.non_json", { correlationId, ordinal });
    return text;
  }
}

export function buildSandboxJob(
  params: {
    source: string;
    entryPoint: string;
    runType: ExecutionRunType;
    testCases: EvaluationTestCase[];
    correlationId: string;
  },
  limits: SandboxJobLimits = DEFAULT_JOB_LIMITS,
): SandboxJob {
  const { source, entryPoint, runType, testCases, correlationId } = params;

  if (!ENTRY_POINT_PATTERN.test(entryPoint)) {
    // Unreachable for a published challenge (guarded by a DB constraint), but
    // a draft or a direct call could still get here.
    throw new ValidationError("Challenge has no valid entry point", {
      entryPoint,
    });
  }

  if (source.length === 0) {
    throw new ValidationError("Solution source is empty");
  }

  if (source.length > limits.maxSourceChars) {
    throw new ValidationError("Solution source exceeds the size limit", {
      length: source.length,
      limit: limits.maxSourceChars,
    });
  }

  if (testCases.length === 0) {
    throw new ValidationError("Challenge has no test cases");
  }

  if (testCases.length > limits.maxTests) {
    throw new ValidationError("Challenge has too many test cases", {
      count: testCases.length,
      limit: limits.maxTests,
    });
  }

  const tests = testCases
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((testCase) => ({
      ordinal: testCase.ordinal,
      args: parseTestArguments(testCase.input, testCase.ordinal, correlationId),
      timeoutMs: Math.min(testCase.timeoutMs, limits.maxTimeoutMs),
    }));

  return {
    protocol: SANDBOX_PROTOCOL_VERSION,
    source,
    entryPoint,
    runType,
    tests,
  };
}

export interface ParsedResultStream {
  records: SandboxTestRecord[];
  startSeen: boolean;
  endReason: "completed" | "budget" | "internal" | null;
  /** Lines that were not valid protocol records — tolerated, but reported. */
  rejectedLines: number;
}

function isRecord(value: unknown): value is SandboxRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.protocol === SANDBOX_PROTOCOL_VERSION &&
    (record.t === "start" || record.t === "test" || record.t === "end")
  );
}

function isTestRecord(record: SandboxRecord): record is SandboxTestRecord {
  if (record.t !== "test") return false;
  return (
    typeof record.ordinal === "number" &&
    Number.isInteger(record.ordinal) &&
    (record.outcome === "returned" ||
      record.outcome === "timeout" ||
      record.outcome === "error") &&
    typeof record.stdout === "string" &&
    typeof record.stderr === "string" &&
    typeof record.durationMs === "number"
  );
}

/**
 * Parse the container's NDJSON result stream.
 *
 * The container's stdout carries only harness records — each child's own output
 * goes to a file — but this stays defensive anyway:
 *
 * - a trailing partial line (container killed mid-write) is discarded;
 * - anything after an `end` record is ignored;
 * - records are de-duplicated by ordinal, keeping the first, because the
 *   harness emits each ordinal exactly once and a repeat means someone is
 *   replaying buckets.
 */
export function parseResultStream(raw: string): ParsedResultStream {
  const records: SandboxTestRecord[] = [];
  const seen = new Set<number>();
  let startSeen = false;
  let endReason: ParsedResultStream["endReason"] = null;
  let rejectedLines = 0;
  let ended = false;

  const lines = raw.split("\n");
  // The final element is either "" (stream ended on a newline) or a partial
  // line from a container that was killed mid-write. Neither is a record.
  for (const line of lines.slice(0, -1)) {
    if (line.trim() === "") continue;
    if (ended) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      rejectedLines += 1;
      continue;
    }

    if (!isRecord(parsed)) {
      rejectedLines += 1;
      continue;
    }

    if (parsed.t === "start") {
      startSeen = true;
      continue;
    }

    if (parsed.t === "end") {
      ended = true;
      endReason = parsed.reason;
      continue;
    }

    if (!isTestRecord(parsed)) {
      rejectedLines += 1;
      continue;
    }

    if (seen.has(parsed.ordinal)) {
      rejectedLines += 1;
      continue;
    }

    seen.add(parsed.ordinal);
    records.push(parsed);
  }

  return { records, startSeen, endReason, rejectedLines };
}
