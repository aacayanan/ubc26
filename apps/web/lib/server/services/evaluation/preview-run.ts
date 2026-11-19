import "server-only";

import { RENDER_PROTOCOL_VERSION } from "@ai-showdown/shared";
import { runBackgroundTask } from "@/lib/server/background/task";
import { logger } from "@/lib/server/logging/logger";
import { getRenderSandboxEnv } from "@/lib/config/sandbox";
import { runRenderContainer } from "@/lib/server/integrations/docker/render-sandbox";
import { assessPartialSource } from "@/lib/server/services/evaluation/source-assembly";
import { upsertPreview } from "@/lib/server/services/pipeline/pipeline-persist";
import type { BriefRecord } from "@/lib/server/services/briefs/briefs";

/**
 * The progressive render (F17).
 *
 * Each finished chunk is rendered and shown, then generation continues — that is
 * the entertainment. It is also, intentionally, not evidence: a partial renderer
 * usually does not parse, was captured at reduced geometry, and was never gated.
 * So this writes to `render_previews`, never to `rendered_artifacts`, and a
 * failure here *never* fails the round.
 *
 * Two rules that make the audience experience right:
 *
 *   * **A chunk that cannot parse is a "compiling…" state, not an error.** The
 *     caller still shows the code growing; nothing is reported as broken.
 *   * **A preview already stored is never re-rendered.** On a resume the caller
 *     re-reads previews instead of re-running the sandbox, which is both faster
 *     and what "does not re-spend tokens on already-rendered chunks" means in
 *     practice.
 */

/** A preview is a thumbnail strip, not a loop: few frames, small canvas. */
export const PREVIEW_FRAMES = 4;
export const PREVIEW_MAX_WIDTH = 240;
export const PREVIEW_MAX_HEIGHT = 180;

export interface RenderPreviewInput {
  executionId: string;
  chunkIndex: number;
  /** The source assembled from every chunk up to and including this one. */
  source: string;
  brief: Pick<
    BriefRecord,
    "entryPoint" | "frameWidth" | "frameHeight" | "targetDurationMs"
  >;
  correlationId: string;
}

export interface RenderPreviewResult {
  rendered: boolean;
  /** False is the "compiling…" state; true means a render was attempted. */
  parseOk: boolean;
  frames: number;
  reason: string | null;
}

/** Scale the brief's geometry down for a preview, preserving aspect ratio. */
export function previewGeometry(brief: {
  frameWidth: number;
  frameHeight: number;
}): { width: number; height: number } {
  const scale = Math.min(
    1,
    PREVIEW_MAX_WIDTH / Math.max(brief.frameWidth, 1),
    PREVIEW_MAX_HEIGHT / Math.max(brief.frameHeight, 1),
  );

  return {
    // At least 1px: a degenerate brief must not make the job invalid.
    width: Math.max(1, Math.round(brief.frameWidth * scale)),
    height: Math.max(1, Math.round(brief.frameHeight * scale)),
  };
}

export async function renderPreview(
  input: RenderPreviewInput,
): Promise<RenderPreviewResult> {
  const { executionId, chunkIndex, source, brief, correlationId } = input;

  return runBackgroundTask(
    {
      task: "evaluation.preview.render",
      correlationId,
      context: { executionId, chunkIndex },
    },
    async () => {
      const assessment = assessPartialSource(source, brief.entryPoint);

      if (!assessment.parsable) {
        // Not an error. The code is shown growing and the panel reads
        // "compiling…" until a later chunk closes the function.
        await upsertPreview({
          executionId,
          chunkIndex,
          parseOk: false,
          rendered: false,
          error: null,
          frames: [],
          imageDigest: null,
          wallMs: null,
        });

        logger.info("preview.pending", {
          correlationId,
          executionId,
          chunkIndex,
          reason: assessment.reason,
        });

        return {
          rendered: false,
          parseOk: false,
          frames: 0,
          reason: assessment.reason,
        };
      }

      const env = getRenderSandboxEnv();
      const { width, height } = previewGeometry(brief);

      const container = await runRenderContainer({
        // Namespaced so the orphan sweep can tell previews from artifacts, and
        // derived from server ids so it is never attacker-shaped.
        containerName: `f17-preview-${executionId}-${chunkIndex}`,
        job: {
          protocol: RENDER_PROTOCOL_VERSION,
          source,
          entryPoint: brief.entryPoint,
          frameCount: PREVIEW_FRAMES,
          frameWidth: width,
          frameHeight: height,
          // The preview covers the same loop the final render will, so what the
          // audience sees is the same motion at lower fidelity.
          targetDurationMs: Math.max(1, brief.targetDurationMs),
          frameTimeoutMs: env.frameTimeoutMs,
        },
        // A preview that hangs must not hold the round: a short wall-clock.
        wallClockMs: Math.min(env.wallClockMs, 30_000),
      });

      const record = container.record;
      const frames = record?.ok ? record.frames.slice(0, PREVIEW_FRAMES) : [];

      // A partial chunk that parses but throws is still not a round failure:
      // the audience sees the growing code, and the next chunk may fix it. Only
      // the finished source is gated (F14).
      const rendered = !container.unavailable && frames.length > 0;
      const reason = container.unavailable
        ? "the render sandbox was unavailable"
        : (record?.pageError ??
          record?.error ??
          (frames.length === 0
            ? "the partial render produced no frames"
            : null));

      await upsertPreview({
        executionId,
        chunkIndex,
        parseOk: true,
        rendered,
        error: reason,
        frames,
        imageDigest: env.imageDigest,
        wallMs: container.wallMs,
      });

      logger.info("preview.rendered", {
        correlationId,
        executionId,
        chunkIndex,
        rendered,
        frames: frames.length,
        wallMs: container.wallMs,
      });

      return { rendered, parseOk: true, frames: frames.length, reason };
    },
  );
}
