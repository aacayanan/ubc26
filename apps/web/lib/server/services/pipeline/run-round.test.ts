import { describe, expect, it } from "vitest";
import type { RoundStatus } from "@ai-showdown/shared";
import { ConflictError } from "@/lib/server/errors/app-error";

/**
 * F17 pipeline gating.
 *
 * Two rules are pure and worth pinning directly:
 *
 *   * the pipeline only starts or resumes from a locked-and-running round —
 *     never from one still taking stakes, and never from a finalized one;
 *   * only a gate-passing render is judged (non-negotiable #9). The full loop's
 *     ordering is exercised end to end in `run-round-pipeline.test.ts`.
 */

const { assertRunnable } =
  await import("@/lib/server/services/pipeline/run-round");

const RUNNABLE: RoundStatus[] = ["LOCKED", "RUNNING", "EVALUATING", "RETRYING"];
const REFUSED: RoundStatus[] = [
  "CREATED",
  "OPEN",
  "SETTLED",
  "ARCHIVED",
  "VOIDED",
  "CANCELLED",
  "FAILED",
];

describe("assertRunnable", () => {
  it.each(RUNNABLE)("accepts %s", (status) => {
    expect(() => assertRunnable(status)).not.toThrow();
  });

  it.each(REFUSED)("refuses %s", (status) => {
    expect(() => assertRunnable(status)).toThrow(ConflictError);
  });

  it("refuses an OPEN round — the betting window has not closed", () => {
    // The two-clocks rule: no render may exist while stakes are still accepted.
    expect(() => assertRunnable("OPEN")).toThrow(/only runs a locked round/);
  });

  it("refuses a SETTLED round so a finalized result is never re-run", () => {
    expect(() => assertRunnable("SETTLED")).toThrow(ConflictError);
  });
});
