import "server-only";

import type { RenderedFrame } from "@ai-showdown/shared";
import { InternalError } from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import type { CheckOutcome } from "@/lib/server/services/evaluation/gate";

/**
 * Writes for `public.rendered_artifacts` (F14).
 *
 * The table has a public SELECT policy and no write policy, so the service role
 * is the only way in. Every write upserts against `execution_id`, which is what
 * makes an interrupted evaluation resume instead of duplicating — the same
 * discipline as `upsertExecution`.
 *
 * Frame bytes are the one thing here that can grow without bound, so the writer
 * owns the cap: a render is N frames of base64 PNG, and storing all of them for
 * three models would publish megabytes per round through a publicly readable
 * table. The capped set keeps enough to replay and to judge, and says when it
 * was cut.
 */

/**
 * Total stored frame bytes per artifact, as JSON text.
 *
 * The seeded briefs are 36 frames of 320x240 — roughly 0.5 MB as base64. 8 MiB
 * leaves room for a larger brief without letting one artifact dominate the
 * table. Frames are dropped from the tail, an order the judge samples evenly
 * across, so the cut changes resolution rather than which part of the loop is
 * visible.
 */
export const STORED_FRAME_BYTES_LIMIT = 8 * 1024 * 1024;

/** A frame as stored: every `RenderedFrame` field except the `png` prefix. */
export type StoredFrame = RenderedFrame;

export interface RenderedArtifactUpsert {
  executionId: string;
  gatePassed: boolean;
  gateFailureReason: string | null;
  checks: CheckOutcome[];
  frameCount: number;
  frameWidth: number | null;
  frameHeight: number | null;
  exitCode: number | null;
  pageError: string | null;
  renderError: string | null;
  unavailable: boolean;
  timedOut: boolean;
  oomKilled: boolean;
  wallMs: number | null;
  imageDigest: string | null;
  harnessProtocol: number | null;
  frames: RenderedFrame[];
}

export interface StoredArtifact {
  executionId: string;
  gatePassed: boolean;
  gateFailureReason: string | null;
  checks: CheckOutcome[];
  frameCount: number;
  frames: StoredFrame[];
  framesTruncated: boolean;
}

/**
 * Keep frames up to a byte budget, in order.
 *
 * Always keeps at least the first frame: a truncated set that is empty tells a
 * viewer nothing, and the first frame is the most useful single image.
 */
export function capFrames(
  frames: RenderedFrame[],
  limitBytes: number = STORED_FRAME_BYTES_LIMIT,
): { frames: RenderedFrame[]; truncated: boolean } {
  const kept: RenderedFrame[] = [];
  let bytes = 0;

  for (const frame of frames) {
    // base64 is ASCII, so byte length is character length.
    const cost = frame.png.length;
    if (kept.length > 0 && bytes + cost > limitBytes) {
      return { frames: kept, truncated: true };
    }
    kept.push(frame);
    bytes += cost;
    if (bytes >= limitBytes) {
      return {
        frames: kept,
        truncated: kept.length < frames.length,
      };
    }
  }

  return { frames: kept, truncated: false };
}

export async function upsertRenderedArtifact(
  row: RenderedArtifactUpsert,
): Promise<{ id: string; framesStored: number; framesTruncated: boolean }> {
  const supabase = getServiceRoleSupabase();
  const { frames, truncated } = capFrames(row.frames);

  const { data, error } = await supabase
    .from("rendered_artifacts")
    .upsert(
      {
        execution_id: row.executionId,
        gate_passed: row.gatePassed,
        gate_failure_reason: row.gateFailureReason,
        checks: row.checks,
        frame_count: row.frameCount,
        frame_width: row.frameWidth,
        frame_height: row.frameHeight,
        exit_code: row.exitCode,
        page_error: row.pageError,
        render_error: row.renderError,
        unavailable: row.unavailable,
        timed_out: row.timedOut,
        oom_killed: row.oomKilled,
        wall_ms: row.wallMs,
        image_digest: row.imageDigest,
        harness_protocol: row.harnessProtocol,
        frames,
        frames_truncated: truncated,
      },
      { onConflict: "execution_id" },
    )
    .select("id")
    .single();

  if (error) {
    throw new InternalError("Failed to record the rendered artifact", error);
  }

  if (truncated) {
    logger.warn("artifact.frames.truncated", {
      executionId: row.executionId,
      stored: frames.length,
      rendered: row.frames.length,
    });
  }

  return {
    id: (data as { id: string }).id,
    framesStored: frames.length,
    framesTruncated: truncated,
  };
}

/**
 * Read one execution's artifact back.
 *
 * This is the replay path: F31 judges stored frames without re-rendering, and
 * F19 renders them for a viewer. Kept here so both read the same shape.
 */
export async function getRenderedArtifact(
  executionId: string,
): Promise<StoredArtifact | null> {
  const supabase = getServiceRoleSupabase();

  const { data, error } = await supabase
    .from("rendered_artifacts")
    .select(
      "execution_id, gate_passed, gate_failure_reason, checks, frame_count, frames, frames_truncated",
    )
    .eq("execution_id", executionId)
    .maybeSingle();

  if (error) {
    throw new InternalError("Failed to read the rendered artifact", error);
  }

  if (!data) return null;

  const row = data as {
    execution_id: string;
    gate_passed: boolean;
    gate_failure_reason: string | null;
    checks: unknown;
    frame_count: number;
    frames: unknown;
    frames_truncated: boolean;
  };

  return {
    executionId: row.execution_id,
    gatePassed: row.gate_passed,
    gateFailureReason: row.gate_failure_reason,
    checks: Array.isArray(row.checks) ? (row.checks as CheckOutcome[]) : [],
    frameCount: row.frame_count,
    frames: Array.isArray(row.frames) ? (row.frames as StoredFrame[]) : [],
    framesTruncated: row.frames_truncated,
  };
}
