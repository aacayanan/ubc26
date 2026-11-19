import { describe, expect, it, vi } from "vitest";

// The runner touches Docker and Postgres; both are replaced so the test is
// about the mapping between a container result and a stored artifact.
vi.mock("@/lib/config/sandbox", () => ({
  getRenderSandboxEnv: () => ({
    dockerBin: "docker",
    imageRef: "img@sha256:" + "a".repeat(64),
    imageDigest: "sha256:" + "a".repeat(64),
    wallClockMs: 90_000,
    frameTimeoutMs: 10_000,
  }),
}));

const runRenderContainer = vi.fn();
vi.mock("@/lib/server/integrations/docker/render-sandbox", () => ({
  runRenderContainer: (...args: unknown[]) => runRenderContainer(...args),
}));

const upsertRenderedArtifact = vi.fn();
vi.mock("@/lib/server/services/evaluation/artifacts", () => ({
  upsertRenderedArtifact: (...args: unknown[]) =>
    upsertRenderedArtifact(...args),
}));

const markExecutionStatus = vi.fn();
vi.mock("@/lib/server/services/evaluation/persist", () => ({
  markExecutionStatus: (...args: unknown[]) => markExecutionStatus(...args),
}));

import {
  buildArtifactRenderJob,
  evaluateArtifact,
  isEligibleForJudging,
} from "@/lib/server/services/evaluation/artifact-run";
import type { BriefRecord } from "@/lib/server/services/briefs/briefs";
import type { RenderContainerResult } from "@/lib/server/integrations/docker/render-sandbox";

const BRIEF: BriefRecord = {
  id: "brief-1",
  slug: "isometric-donut",
  version: 1,
  title: "Isometric donut",
  prompt: "Draw a donut.",
  styleConstraints: "Two flat fills.",
  entryPoint: "drawFrame",
  targetDurationMs: 1200,
  frameCount: 2,
  frameWidth: 320,
  frameHeight: 240,
  deterministicChecks: [
    { kind: "process_exit", expect: 0 },
    { kind: "no_uncaught_error" },
    { kind: "frames_emitted", expect: 2 },
    { kind: "frame_dimensions", expect: "320x240" },
    { kind: "non_blank" },
  ],
  judgeRubric: [],
  starterCode: "",
  referenceImpl: "function drawFrame() {}",
  referenceValidatedAt: null,
};

function frame(index: number, blank = false) {
  return {
    index,
    png: "iVBORw0KGgo=",
    blank,
    distinctColors: blank ? 1 : 12,
    width: 320,
    height: 240,
  };
}

function container(
  overrides: Partial<RenderContainerResult> = {},
): RenderContainerResult {
  return {
    record: {
      t: "render",
      protocol: 1,
      ok: true,
      error: null,
      pageError: null,
      frames: [frame(0), frame(1)],
    },
    stderr: "",
    exitCode: 0,
    oomKilled: false,
    timedOut: false,
    wallMs: 1_500,
    unavailable: false,
    ...overrides,
  };
}

function stubWrite(): void {
  upsertRenderedArtifact.mockResolvedValue({
    id: "artifact-1",
    framesStored: 2,
    framesTruncated: false,
  });
}

describe("buildArtifactRenderJob", () => {
  it("uses the brief's frame geometry and never a clock", () => {
    const job = buildArtifactRenderJob("function drawFrame(){}", BRIEF);
    expect(job.frameCount).toBe(BRIEF.frameCount);
    expect(job.targetDurationMs).toBe(BRIEF.targetDurationMs);
    expect(job.frameWidth).toBe(320);
    expect(job.frameHeight).toBe(240);
    expect(job.entryPoint).toBe("drawFrame");
  });
});

describe("isEligibleForJudging", () => {
  it("only a passing gate is eligible", () => {
    expect(isEligibleForJudging(true)).toBe(true);
    expect(isEligibleForJudging(false)).toBe(false);
  });
});

describe("evaluateArtifact", () => {
  it("stores the artifact and reports eligibility on a clean render", async () => {
    const c = container();
    runRenderContainer.mockResolvedValue(c);
    stubWrite();

    const result = await evaluateArtifact({
      executionId: "exec-1",
      source: "function drawFrame(t, ctx) {}",
      brief: BRIEF,
      correlationId: "corr-1",
    });

    expect(result.gatePassed).toBe(true);
    expect(result.eligibleForJudging).toBe(true);
    expect(result.framesRendered).toBe(2);
    expect(result.artifactId).toBe("artifact-1");

    const row = upsertRenderedArtifact.mock.calls[0][0];
    expect(row.executionId).toBe("exec-1");
    expect(row.gatePassed).toBe(true);
    expect(row.frames).toHaveLength(2);
    expect(row.imageDigest).toMatch(/^sha256:/);

    // A clean render leaves the generation execution alone.
    expect(markExecutionStatus).not.toHaveBeenCalled();
  });

  it("marks a failed gate ineligible but does not touch execution status", async () => {
    runRenderContainer.mockResolvedValue(
      container({
        record: {
          t: "render",
          protocol: 1,
          ok: true,
          error: null,
          pageError: null,
          frames: [frame(0, true), frame(1, true)],
        },
      }),
    );
    stubWrite();

    const result = await evaluateArtifact({
      executionId: "exec-2",
      source: "function drawFrame(t, ctx) {}",
      brief: BRIEF,
      correlationId: "corr-2",
    });

    expect(result.gatePassed).toBe(false);
    expect(result.eligibleForJudging).toBe(false);
    // A blank render still ran: F15, not F14, decides what it costs.
    expect(markExecutionStatus).not.toHaveBeenCalled();
  });

  it("marks the execution unavailable when the sandbox never ran", async () => {
    runRenderContainer.mockResolvedValue(
      container({ unavailable: true, record: null, exitCode: null }),
    );
    stubWrite();

    const result = await evaluateArtifact({
      executionId: "exec-3",
      source: "function drawFrame(t, ctx) {}",
      brief: BRIEF,
      correlationId: "corr-3",
    });

    expect(result.gatePassed).toBe(false);
    expect(result.eligibleForJudging).toBe(false);
    expect(result.unavailable).toBe(true);
    expect(markExecutionStatus).toHaveBeenCalledWith(
      "exec-3",
      "unavailable",
      expect.objectContaining({ errorMessage: "Render sandbox unavailable" }),
    );
  });

  it("refuses an empty source", async () => {
    await expect(
      evaluateArtifact({
        executionId: "exec-4",
        source: "   ",
        brief: BRIEF,
        correlationId: "corr-4",
      }),
    ).rejects.toThrow(/empty render source/);
  });

  it("never lets model output name the container", async () => {
    runRenderContainer.mockResolvedValue(container());
    stubWrite();

    await evaluateArtifact({
      executionId: "exec-5",
      source: "function drawFrame(){} // f14-render-evil",
      brief: BRIEF,
      correlationId: "corr-5",
    });

    const name = (
      runRenderContainer.mock.calls[0][0] as { containerName: string }
    ).containerName;
    expect(name).toBe("f14-render-exec-5");
  });
});
