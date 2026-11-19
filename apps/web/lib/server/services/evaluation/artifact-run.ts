import "server-only";

import { RENDER_PROTOCOL_VERSION, type RenderJob } from "@ai-showdown/shared";
import { ValidationError } from "@/lib/server/errors/app-error";
import { runBackgroundTask } from "@/lib/server/background/task";
import { logger } from "@/lib/server/logging/logger";
import { getRenderSandboxEnv } from "@/lib/config/sandbox";
import { runRenderContainer } from "@/lib/server/integrations/docker/render-sandbox";
import type { BriefRecord } from "@/lib/server/services/briefs/briefs";
import { assessRender } from "@/lib/server/services/evaluation/observe";
import type { CheckOutcome } from "@/lib/server/services/evaluation/gate";
import { markExecutionStatus } from "@/lib/server/services/evaluation/persist";
import {
  upsertRenderedArtifact,
  type StoredFrame,
} from "@/lib/server/services/evaluation/artifacts";

/**
 * Render one model's generated code and gate the result (F14).
 *
 * This is the artifact half of the F17 pipeline: F17 generates code and records
 * a `generation` execution, then calls this with that execution id and the
 * stored source. It renders in the same quarantined Chromium sandbox the brief
 * validator uses, decides the deterministic checks on the host, and persists the
 * frames and verdict together.
 *
 * Two rules this module is responsible for keeping true:
 *
 *   * **Frames are captured at explicit time steps.** The job carries a frame
 *     count and a duration; the harness derives each frame's time from them and
 *     never from a clock. Nothing here passes wall-clock into the render.
 *   * **The render is an observation.** A model gets no credit for what its code
 *     claims; the gate compares the measured frames to the brief on this side.
 *
 * The generation execution's status is left alone on a clean sandbox run — a
 * solution that renders badly still generated, and F15 decides what its gate
 * outcome costs. Only infrastructure failure is marked `unavailable`, because
 * that is the one thing that is not the model's fault.
 */

export interface EvaluateArtifactInput {
  /** `model_executions.id` for the generation that produced `source`. */
  executionId: string;
  /** The model's generated source. Never logged — the logger redacts it. */
  source: string;
  brief: BriefRecord;
  correlationId: string;
}

export interface EvaluateArtifactResult {
  /** The stored artifact id, for a replay read via `getRenderedArtifact`. */
  artifactId: string;
  gatePassed: boolean;
  gateFailureReason: string | null;
  checks: CheckOutcome[];
  /** True when the model may be sent to the judge and earn fan-favorite points. */
  eligibleForJudging: boolean;
  framesRendered: number;
  framesStored: number;
  framesTruncated: boolean;
  /** Infrastructure failure only; a failed gate is not a failed run. */
  unavailable: boolean;
  /**
   * The stored frames, for the judge stage to use without a second read. Empty
   * when the render produced nothing.
   */
  frames: StoredFrame[];
}

/** Build the render job for model code from a brief. */
export function buildArtifactRenderJob(
  source: string,
  brief: BriefRecord,
): RenderJob {
  const env = getRenderSandboxEnv();

  return {
    protocol: RENDER_PROTOCOL_VERSION,
    source,
    entryPoint: brief.entryPoint,
    frameCount: brief.frameCount,
    frameWidth: brief.frameWidth,
    frameHeight: brief.frameHeight,
    targetDurationMs: brief.targetDurationMs,
    frameTimeoutMs: env.frameTimeoutMs,
  };
}

export async function evaluateArtifact(
  input: EvaluateArtifactInput,
): Promise<EvaluateArtifactResult> {
  const { executionId, source, brief, correlationId } = input;

  if (source.trim() === "") {
    throw new ValidationError("Cannot evaluate an empty render source");
  }

  return runBackgroundTask(
    {
      task: "evaluation.artifact.render",
      correlationId,
      context: { executionId, briefSlug: brief.slug, version: brief.version },
    },
    async () => {
      const env = getRenderSandboxEnv();

      const container = await runRenderContainer({
        // Derived from the execution id the server controls, never from model
        // output, so the timeout path can find the container and the orphan
        // sweep stays safe.
        containerName: `f14-render-${executionId}`,
        job: buildArtifactRenderJob(source, brief),
        wallClockMs: env.wallClockMs,
      });

      const assessment = assessRender(container, brief);

      const stored = await upsertRenderedArtifact({
        executionId,
        gatePassed: assessment.gate.passed,
        gateFailureReason: assessment.gate.failureReason,
        checks: assessment.gate.checks,
        frameCount: assessment.record?.frames.length ?? 0,
        frameWidth: assessment.observation?.measuredWidth ?? null,
        frameHeight: assessment.observation?.measuredHeight ?? null,
        exitCode: container.exitCode,
        pageError: assessment.record?.pageError ?? null,
        renderError: assessment.record?.error ?? assessment.failureReason,
        unavailable: container.unavailable,
        timedOut: container.timedOut,
        oomKilled: container.oomKilled,
        wallMs: container.wallMs,
        imageDigest: env.imageDigest,
        harnessProtocol: RENDER_PROTOCOL_VERSION,
        frames: assessment.record?.frames ?? [],
      });

      if (container.unavailable) {
        // Infrastructure, not the model: F15/F16 apply a retry policy, not a
        // conformance verdict.
        await markExecutionStatus(executionId, "unavailable", {
          errorMessage: "Render sandbox unavailable",
          finishedAt: new Date().toISOString(),
        });
      }

      logger.info("artifact.evaluated", {
        correlationId,
        executionId,
        gatePassed: assessment.gate.passed,
        frames: assessment.record?.frames.length ?? 0,
        framesStored: stored.framesStored,
        framesTruncated: stored.framesTruncated,
        wallMs: container.wallMs,
      });

      return {
        artifactId: stored.id,
        gatePassed: assessment.gate.passed,
        gateFailureReason: assessment.gate.failureReason,
        checks: assessment.gate.checks,
        eligibleForJudging: isEligibleForJudging(assessment.gate.passed),
        framesRendered: assessment.record?.frames.length ?? 0,
        framesStored: stored.framesStored,
        framesTruncated: stored.framesTruncated,
        unavailable: container.unavailable,
        frames: assessment.record?.frames ?? [],
      };
    },
  );
}

/**
 * The single rule that turns a gate outcome into judging eligibility.
 *
 * A model that failed the deterministic gate is never sent to the judge and
 * never qualifies for fan-favorite points (F14/F15). Kept as one predicate so
 * F17 and F31 cannot each invent their own reading of `gate_passed`.
 */
export function isEligibleForJudging(gatePassed: boolean): boolean {
  return gatePassed;
}
