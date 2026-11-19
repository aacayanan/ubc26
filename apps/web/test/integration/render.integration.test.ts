import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { runRenderContainer } from "@/lib/server/integrations/docker/render-sandbox";
import { assessRender } from "@/lib/server/services/evaluation/observe";
import { buildArtifactRenderJob } from "@/lib/server/services/evaluation/artifact-run";
import type { BriefRecord } from "@/lib/server/services/briefs/briefs";
import type { RenderedFrame } from "@ai-showdown/shared";

/**
 * A real render through the pinned sandbox image (F14 acceptance check).
 *
 * Proves the two claims the unit tests can only assert by construction:
 *
 *   1. the same code + the same brief + the same pinned image produce the same
 *      frames (determinism at explicit time steps, never wall-clock), and
 *   2. the host-side gate reads those frames correctly.
 *
 * Skipped unless RENDER_SANDBOX_IMAGE is a digest-pinned reference and a Docker
 * daemon is reachable, so `npm test` never needs either. Run it explicitly:
 *
 *   RENDER_SANDBOX_IMAGE="$(docker image inspect ai-showdown-render:chromium \
 *     --format '{{index .RepoDigests 0}}')" \
 *     npx vitest run --root apps/web test/integration/render.integration.test.ts
 */

const image = process.env.RENDER_SANDBOX_IMAGE;

/**
 * A known-good frame renderer: a torus that rotates linearly with `t`.
 *
 * Deliberately the same shape as a seeded brief's reference implementation —
 * a pure function of `t`, no randomness, no clock — so two renders differing
 * at all would mean the harness leaked non-determinism.
 */
const SOURCE = `
function drawFrame(t, ctx, canvas) {
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2;
  const phase = (t / 1200) * Math.PI * 2;
  ctx.fillStyle = "#05040A";
  ctx.fillRect(0, 0, w, h);
  const outer = Math.min(w, h) * 0.36;
  const inner = outer * 0.42;
  const squash = 0.5;
  const lit = ["#FF2E93", "#7C6BFF"];
  for (let side = 0; side < 2; side++) {
    const start = phase + side * Math.PI;
    ctx.beginPath();
    ctx.ellipse(cx, cy, outer, outer * squash, 0, start, start + Math.PI);
    ctx.ellipse(cx, cy, inner, inner * squash, 0, start + Math.PI, start, true);
    ctx.closePath();
    ctx.fillStyle = lit[side];
    ctx.fill();
  }
}
`;

const BRIEF: BriefRecord = {
  id: "integration-brief",
  slug: "f14-integration-donut",
  version: 1,
  title: "Isometric donut",
  prompt: "Draw a spinning donut.",
  styleConstraints: "Two flat fills on a void background.",
  entryPoint: "drawFrame",
  targetDurationMs: 1200,
  frameCount: 6,
  frameWidth: 320,
  frameHeight: 240,
  deterministicChecks: [
    { kind: "process_exit", expect: 0 },
    { kind: "no_uncaught_error" },
    { kind: "frames_emitted", expect: 6 },
    { kind: "frame_dimensions", expect: "320x240" },
    { kind: "non_blank" },
  ],
  judgeRubric: [],
  starterCode: "",
  referenceImpl: SOURCE,
  referenceValidatedAt: null,
};

/** The frame bytes only — dimensions and blankness are separate claims. */
function frameHash(frames: RenderedFrame[]): string {
  const hash = createHash("sha256");
  for (const frame of frames) hash.update(frame.png);
  return hash.digest("hex");
}

describe.skipIf(!image)("F14 render integration", () => {
  it("renders the same frames twice and passes the gate", async () => {
    const renderOnce = async (suffix: string) =>
      runRenderContainer({
        containerName: `f14-integration-${suffix}`,
        job: buildArtifactRenderJob(SOURCE, BRIEF),
        wallClockMs: 90_000,
      });

    const first = await renderOnce("a");
    const second = await renderOnce("b");

    expect(first.unavailable, "sandbox unavailable").toBe(false);
    expect(first.timedOut).toBe(false);
    expect(first.record, "no result record").not.toBeNull();
    expect(first.record?.ok).toBe(true);

    const firstGate = assessRender(first, BRIEF);
    const secondGate = assessRender(second, BRIEF);

    expect(firstGate.gate.passed, firstGate.gate.failureReason ?? "").toBe(
      true,
    );
    expect(secondGate.gate.passed).toBe(true);

    // The acceptance criterion: identical code, brief and image → identical
    // frames. A mismatch here means the harness captured at wall-clock time
    // or the image is not actually pinned.
    const framesA = first.record?.frames ?? [];
    const framesB = second.record?.frames ?? [];
    expect(framesA).toHaveLength(BRIEF.frameCount);
    expect(frameHash(framesA)).toBe(frameHash(framesB));

    // And each frame is a distinct moment, not the same frame repeated —
    // otherwise a "deterministic" hash would be trivially stable.
    const distinct = new Set(framesA.map((frame) => frame.png));
    expect(distinct.size).toBeGreaterThan(1);
  }, 240_000);
});
