import "server-only";

import type { RenderJob } from "@ai-showdown/shared";
import { RENDER_PROTOCOL_VERSION } from "@ai-showdown/shared";
import { getRenderSandboxEnv } from "@/lib/config/sandbox";
import { logger } from "@/lib/server/logging/logger";
import {
  runRenderContainer,
  type RenderContainerResult,
} from "@/lib/server/integrations/docker/render-sandbox";
import type { GateOutcome } from "@/lib/server/services/evaluation/gate";
import { assessRender } from "@/lib/server/services/evaluation/observe";
import {
  getBriefVersion,
  publishBrief,
  seedBrief,
  type BriefRecord,
  type BriefSeedDocument,
} from "@/lib/server/services/briefs/briefs";

/**
 * Validate a brief by rendering its reference implementation (F12).
 *
 * This is the load-bearing step behind "a reference implementation per brief
 * renders successfully in the sandbox before publishing". Publishing goes
 * through `publishBrief` only when the gate passed, so the database's
 * `reference_validated_at` stamp is evidence of a real render rather than a
 * promise.
 *
 * A brief whose reference fails is left as a draft with the failing reason
 * returned to the operator — the seed stays in the table so the fix is a
 * re-seed (which bumps the version) rather than a manual repair.
 */

export interface ReferenceRenderResult {
  slug: string;
  version: number;
  gate: GateOutcome;
  container: Pick<
    RenderContainerResult,
    "unavailable" | "timedOut" | "oomKilled" | "exitCode" | "wallMs"
  >;
  published: boolean;
  /** Plain-language explanation, safe for an operator or a log. */
  summary: string;
}

/** Build the job the render container consumes from a stored brief. */
export function buildRenderJob(brief: BriefRecord): RenderJob {
  const env = getRenderSandboxEnv();

  return {
    protocol: RENDER_PROTOCOL_VERSION,
    source: brief.referenceImpl,
    entryPoint: brief.entryPoint,
    frameCount: brief.frameCount,
    frameWidth: brief.frameWidth,
    frameHeight: brief.frameHeight,
    targetDurationMs: brief.targetDurationMs,
    frameTimeoutMs: env.frameTimeoutMs,
  };
}

/**
 * Render one brief's reference implementation and gate the result.
 *
 * Does not publish — `validateAndPublish` is the composing entry point, and
 * keeping the render separable lets a caller inspect frames before deciding.
 */
export async function runReferenceRender(
  brief: BriefRecord,
): Promise<{ container: RenderContainerResult; gate: GateOutcome }> {
  const env = getRenderSandboxEnv();

  const container = await runRenderContainer({
    // Derived from the brief's own identity, never from request input, so the
    // timeout path can find the container and the orphan sweep stays safe.
    containerName: `f12-render-${brief.slug}-${brief.version}`,
    job: buildRenderJob(brief),
    wallClockMs: env.wallClockMs,
  });

  const gate = evaluateContainer(container, brief);
  return { container, gate };
}

/**
 * Turn a container result into a gate outcome.
 *
 * The mapping itself lives in `evaluation/observe.ts`, shared with F14's model
 * artifact evaluation so a reference render and a model render are gated by the
 * same rules.
 */
function evaluateContainer(
  container: RenderContainerResult,
  brief: BriefRecord,
): GateOutcome {
  return assessRender(container, brief).gate;
}

/**
 * Render, gate, and publish on success.
 *
 * The only path that publishes a brief, so every published brief carries a
 * `reference_validated_at` that a real render produced.
 */
export async function validateAndPublish(
  brief: BriefRecord,
): Promise<ReferenceRenderResult> {
  const { container, gate } = await runReferenceRender(brief);

  if (!gate.passed) {
    logger.warn("brief.reference.failed", {
      slug: brief.slug,
      version: brief.version,
      reason: gate.failureReason,
    });

    return {
      slug: brief.slug,
      version: brief.version,
      gate,
      container: pickContainer(container),
      published: false,
      summary: `Reference render for ${brief.slug} v${brief.version} failed: ${
        gate.failureReason ?? "unknown reason"
      }. The brief remains a draft.`,
    };
  }

  const env = getRenderSandboxEnv();
  await publishBrief({
    slug: brief.slug,
    version: brief.version,
    imageDigest: env.imageDigest,
  });

  logger.info("brief.reference.published", {
    slug: brief.slug,
    version: brief.version,
    frames: brief.frameCount,
    wallMs: container.wallMs,
  });

  return {
    slug: brief.slug,
    version: brief.version,
    gate,
    container: pickContainer(container),
    published: true,
    summary: `Reference render for ${brief.slug} v${brief.version} passed all checks and the brief is published.`,
  };
}

function pickContainer(container: RenderContainerResult) {
  return {
    unavailable: container.unavailable,
    timedOut: container.timedOut,
    oomKilled: container.oomKilled,
    exitCode: container.exitCode,
    wallMs: container.wallMs,
  };
}

/**
 * Seed every document, then validate and publish the drafts that were just
 * created.
 *
 * Re-running is safe: `seedBrief` returns `unchanged` for an identical
 * document, and an unchanged brief is skipped here rather than re-rendered.
 * A changed document becomes a new draft version and is rendered again, so
 * editing a brief always re-earns its publish.
 */
export async function seedAndValidateBriefs(
  documents: BriefSeedDocument[],
): Promise<ReferenceRenderResult[]> {
  const results: ReferenceRenderResult[] = [];

  for (const document of documents) {
    const seeded = await seedBrief(document);

    if (seeded.action === "unchanged") {
      logger.info("brief.seed.unchanged", {
        slug: seeded.slug,
        version: seeded.version,
      });
      continue;
    }

    const brief = await getBriefVersion(seeded.slug, seeded.version);
    results.push(await validateAndPublish(brief));
  }

  return results;
}
