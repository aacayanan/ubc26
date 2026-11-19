import "server-only";

import type {
  DeterministicCheck,
  RenderResultRecord,
} from "@ai-showdown/shared";
import type { RenderContainerResult } from "@/lib/server/integrations/docker/render-sandbox";
import {
  evaluateGate,
  type GateOutcome,
  type RenderObservation,
} from "@/lib/server/services/evaluation/gate";

/**
 * Turning a container result into a gate verdict (F14).
 *
 * Both callers that exist — the brief validator (F12) and model artifact
 * evaluation (F14) — must agree on what a container result means, or the same
 * frames would qualify a reference implementation and fail a model. So the
 * mapping lives here once, and each caller supplies only the checks and the
 * dimensions to test against.
 *
 * Kept free of persistence so it can be exercised on a recorded container
 * result, and so `RenderedArtifact` rows can be re-derived from storage.
 */

/** The part of a brief the gate needs. Structural so a `BriefRecord` fits. */
export interface GateBrief {
  frameWidth: number;
  frameHeight: number;
  deterministicChecks: DeterministicCheck[];
}

export interface RenderAssessment {
  gate: GateOutcome;
  /**
   * What was measured, or null when the render produced nothing to measure.
   * Persisted alongside the verdict so a disputed result is re-readable.
   */
  observation: RenderObservation | null;
  /**
   * Infrastructure or render-level failure, in plain language, or null.
   * A failed gate is not a failure reason — that is `gate.failureReason`.
   */
  failureReason: string | null;
  /**
   * True when Docker itself never produced a result (daemon down, missing
   * image). Infrastructure, never the model's fault (F15).
   */
  unavailable: boolean;
  /** The container's parsed record, or null when it produced none. */
  record: RenderResultRecord | null;
}

/**
 * Decide what one container result means for a brief.
 *
 * An infrastructure failure is reported as a failed `process_exit` rather than a
 * special case: a reader of the artifact needs to know the render did not
 * happen, and the reason says why.
 */
export function assessRender(
  container: RenderContainerResult,
  brief: GateBrief,
): RenderAssessment {
  const base = {
    observation: null,
    record: container.record,
    unavailable: container.unavailable,
  };

  if (container.unavailable) {
    return {
      ...base,
      gate: failedGate(
        brief,
        "The render sandbox was unavailable — no image or no Docker daemon.",
      ),
      failureReason:
        "The render sandbox was unavailable — no image or no Docker daemon.",
    };
  }

  if (container.timedOut) {
    const reason = "The render exceeded the wall-clock limit.";
    return { ...base, gate: failedGate(brief, reason), failureReason: reason };
  }

  if (container.oomKilled) {
    const reason = "The render exceeded its memory limit.";
    return { ...base, gate: failedGate(brief, reason), failureReason: reason };
  }

  const record = container.record;
  if (record === null) {
    const reason = "The render produced no result record.";
    return { ...base, gate: failedGate(brief, reason), failureReason: reason };
  }

  if (!record.ok) {
    const reason = `The render failed: ${record.error ?? "unknown error"}`;
    return {
      ...base,
      record,
      gate: failedGate(brief, reason),
      failureReason: reason,
    };
  }

  // The dimensions the *frames* came back at, not the ones the brief asked for.
  // A solution that resizes the canvas shows up here and fails the check;
  // echoing the brief's dimensions would make frame_dimensions tautological.
  const measured = measureFrames(record.frames);

  const observation: RenderObservation = {
    exitCode: container.exitCode,
    pageError: record.pageError,
    frames: record.frames,
    frameWidth: brief.frameWidth,
    frameHeight: brief.frameHeight,
    measuredWidth: measured.width,
    measuredHeight: measured.height,
  };

  return {
    gate: evaluateGate(brief.deterministicChecks, observation),
    observation,
    failureReason: null,
    unavailable: false,
    record,
  };
}

/**
 * The size the frames were actually rendered at.
 *
 * Every frame should agree. If one deviates, that deviating size is reported —
 * an inconsistent render should fail the gate, not be averaged away.
 */
export function measureFrames(frames: RenderResultRecord["frames"]): {
  width: number | null;
  height: number | null;
} {
  if (frames.length === 0) return { width: null, height: null };

  const { width, height } = frames[0];
  const deviating = frames.find(
    (frame) => frame.width !== width || frame.height !== height,
  );

  return deviating
    ? { width: deviating.width, height: deviating.height }
    : { width, height };
}

/** A gate where every declared check failed for one shared reason. */
export function failedGate(brief: GateBrief, reason: string): GateOutcome {
  return {
    passed: false,
    failureReason: reason,
    checks: brief.deterministicChecks.map((check) => ({
      kind: check.kind,
      passed: false,
      reason,
      observed: "not run",
    })),
  };
}
