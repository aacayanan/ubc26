import "server-only";

import type {
  DeterministicCheck,
  DeterministicCheckKind,
  RenderedFrame,
} from "@ai-showdown/shared";

/**
 * The deterministic gate (F12 definitions, F14 execution).
 *
 * A brief declares which checks apply; this module decides what they mean
 * against what the container actually produced. Kept pure and free of I/O so
 * every rule is unit-testable and a verdict can be replayed from stored frames
 * without re-rendering.
 *
 * The gate is a *qualification* rule, not a score: a model that fails it is
 * never sent to the judge and never eligible for fan-favourite points (F15).
 * So each check reports its own outcome and the aggregate is the conjunction —
 * a single failure is decisive, and the reason says which one.
 */

export interface CheckOutcome {
  kind: DeterministicCheckKind;
  passed: boolean;
  /** Plain-language reason, safe to show a user (F19). */
  reason: string;
  /** What was measured, for diagnostics. */
  observed: string;
}

export interface GateOutcome {
  passed: boolean;
  checks: CheckOutcome[];
  /** The first failing check's reason, or null when the gate passed. */
  failureReason: string | null;
}

/** What the render actually produced, as the gate sees it. */
export interface RenderObservation {
  /** Process exit code; null when the container never started. */
  exitCode: number | null;
  /** An uncaught page error, if the page threw while drawing. */
  pageError: string | null;
  frames: RenderedFrame[];
  /** Frame dimensions the brief required. */
  frameWidth: number;
  frameHeight: number;
  /** PNG width/height as measured, when the container could report them. */
  measuredWidth: number | null;
  measuredHeight: number | null;
}

/**
 * Every brief must define these. Mirrors `required_brief_check_kinds()` in
 * 20261118101500_visual_briefs.sql — a brief missing one cannot publish, so a
 * published brief always reaches this function with a full set.
 */
export const REQUIRED_CHECK_KINDS: readonly DeterministicCheckKind[] = [
  "process_exit",
  "no_uncaught_error",
  "frames_emitted",
  "frame_dimensions",
  "non_blank",
];

/**
 * Run every check a brief declares against one render.
 *
 * A declared kind the gate does not know is treated as failed rather than
 * ignored: silently dropping a check would let a brief promise something that
 * never gets verified.
 */
export function evaluateGate(
  checks: DeterministicCheck[],
  observation: RenderObservation,
): GateOutcome {
  const outcomes = checks.map((check) => runCheck(check, observation));
  const failed = outcomes.find((outcome) => !outcome.passed);

  return {
    passed: failed === undefined,
    checks: outcomes,
    failureReason: failed ? failed.reason : null,
  };
}

function runCheck(
  check: DeterministicCheck,
  observation: RenderObservation,
): CheckOutcome {
  switch (check.kind) {
    case "process_exit": {
      const expected = typeof check.expect === "number" ? check.expect : 0;
      const passed = observation.exitCode === expected;
      return {
        kind: check.kind,
        passed,
        reason: passed
          ? "The render process exited cleanly."
          : `The render process exited with ${observation.exitCode ?? "no status"} instead of ${expected}.`,
        observed: String(observation.exitCode),
      };
    }

    case "no_uncaught_error": {
      const passed = observation.pageError === null;
      return {
        kind: check.kind,
        passed,
        reason: passed
          ? "The page ran without throwing."
          : `The page threw an uncaught error: ${observation.pageError}`,
        observed: observation.pageError ?? "none",
      };
    }

    case "frames_emitted": {
      const expected =
        typeof check.expect === "number"
          ? check.expect
          : observation.frames.length;
      const passed = observation.frames.length === expected;
      return {
        kind: check.kind,
        passed,
        reason: passed
          ? `Produced all ${expected} frames.`
          : `Produced ${observation.frames.length} frames; the brief requires ${expected}.`,
        observed: String(observation.frames.length),
      };
    }

    case "frame_dimensions": {
      const passed = dimensionsMatch(check.expect, observation);
      const actual =
        observation.measuredWidth !== null &&
        observation.measuredHeight !== null
          ? `${observation.measuredWidth}x${observation.measuredHeight}`
          : "unknown";
      return {
        kind: check.kind,
        passed,
        reason: passed
          ? `Frames are ${actual}.`
          : `Frames are ${actual}; the brief requires ${String(check.expect)}.`,
        observed: actual,
      };
    }

    case "non_blank": {
      // A single flat-colour frame is a blank frame. All-blank is the obvious
      // failure; the check is "not every frame is blank", because a brief may
      // legitimately open or close on an empty canvas.
      const allBlank =
        observation.frames.length > 0 &&
        observation.frames.every((frame) => frame.blank);
      const passed = observation.frames.length > 0 && !allBlank;
      return {
        kind: check.kind,
        passed,
        reason: passed
          ? "Frames carry real content."
          : "Every frame is a single flat colour — nothing was drawn.",
        observed: allBlank ? "all blank" : "content present",
      };
    }

    default: {
      // Exhaustive over DeterministicCheckKind; this arm exists so a new kind
      // added to the union without a rule here fails loudly instead of passing.
      const unreachable: never = check.kind;
      return {
        kind: unreachable,
        passed: false,
        reason: `Unknown check kind: ${String(unreachable)}`,
        observed: "unknown",
      };
    }
  }
}

function dimensionsMatch(
  expect: number | string | undefined,
  observation: RenderObservation,
): boolean {
  const measuredWidth = observation.measuredWidth ?? observation.frameWidth;
  const measuredHeight = observation.measuredHeight ?? observation.frameHeight;

  if (measuredWidth !== observation.frameWidth) return false;
  if (measuredHeight !== observation.frameHeight) return false;

  if (typeof expect === "string") {
    const [w, h] = expect.split("x").map((part) => Number.parseInt(part, 10));
    return w === measuredWidth && h === measuredHeight;
  }

  return true;
}
