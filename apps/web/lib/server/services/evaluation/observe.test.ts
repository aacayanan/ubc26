import { describe, expect, it } from "vitest";
import type { RenderResultRecord } from "@ai-showdown/shared";
import type { RenderContainerResult } from "@/lib/server/integrations/docker/render-sandbox";
import {
  assessRender,
  measureFrames,
  type GateBrief,
} from "@/lib/server/services/evaluation/observe";

const BRIEF: GateBrief = {
  frameWidth: 320,
  frameHeight: 240,
  deterministicChecks: [
    { kind: "process_exit", expect: 0 },
    { kind: "no_uncaught_error" },
    { kind: "frames_emitted", expect: 2 },
    { kind: "frame_dimensions", expect: "320x240" },
    { kind: "non_blank" },
  ],
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

function record(
  overrides: Partial<RenderResultRecord> = {},
): RenderResultRecord {
  return {
    t: "render",
    protocol: 1,
    ok: true,
    error: null,
    pageError: null,
    frames: [frame(0), frame(1)],
    ...overrides,
  };
}

function container(
  overrides: Partial<RenderContainerResult> = {},
): RenderContainerResult {
  return {
    record: record(),
    stderr: "",
    exitCode: 0,
    oomKilled: false,
    timedOut: false,
    wallMs: 1_000,
    unavailable: false,
    ...overrides,
  };
}

describe("assessRender", () => {
  it("passes a clean render", () => {
    const assessment = assessRender(container(), BRIEF);
    expect(assessment.gate.passed).toBe(true);
    expect(assessment.failureReason).toBeNull();
    expect(assessment.unavailable).toBe(false);
    expect(assessment.observation).not.toBeNull();
  });

  it("reports an unavailable sandbox as a failed gate, flagging infrastructure", () => {
    const assessment = assessRender(
      container({ unavailable: true, record: null, exitCode: null }),
      BRIEF,
    );
    expect(assessment.gate.passed).toBe(false);
    expect(assessment.unavailable).toBe(true);
    expect(assessment.gate.failureReason).toMatch(/unavailable/i);
  });

  it("fails a timed-out render", () => {
    const assessment = assessRender(
      container({ timedOut: true, exitCode: null }),
      BRIEF,
    );
    expect(assessment.gate.passed).toBe(false);
    expect(assessment.unavailable).toBe(false);
    expect(assessment.gate.failureReason).toMatch(/wall-clock/);
  });

  it("fails an OOM-killed render", () => {
    const assessment = assessRender(container({ oomKilled: true }), BRIEF);
    expect(assessment.gate.passed).toBe(false);
    expect(assessment.gate.failureReason).toMatch(/memory/);
  });

  it("fails when the container produced no record", () => {
    const assessment = assessRender(container({ record: null }), BRIEF);
    expect(assessment.gate.passed).toBe(false);
    expect(assessment.gate.failureReason).toMatch(/no result record/);
  });

  it("fails when the harness reports ok:false", () => {
    const assessment = assessRender(
      container({ record: record({ ok: false, error: "bad source" }) }),
      BRIEF,
    );
    expect(assessment.gate.passed).toBe(false);
    expect(assessment.gate.failureReason).toContain("bad source");
  });

  it("gates on the frames the model actually produced", () => {
    const assessment = assessRender(
      container({ record: record({ frames: [frame(0)] }) }),
      BRIEF,
    );
    expect(assessment.gate.passed).toBe(false);
    expect(
      assessment.gate.checks.find((c) => c.kind === "frames_emitted")?.passed,
    ).toBe(false);
  });

  it("attributes a page throw to no_uncaught_error", () => {
    const assessment = assessRender(
      container({ record: record({ pageError: "TypeError: boom" }) }),
      BRIEF,
    );
    expect(assessment.gate.passed).toBe(false);
    expect(assessment.gate.failureReason).toContain("boom");
  });

  it("carries the measured dimensions into the observation", () => {
    const assessment = assessRender(
      container({
        record: record({
          frames: [
            { ...frame(0), width: 640, height: 480 },
            { ...frame(1), width: 640, height: 480 },
          ],
        }),
      }),
      BRIEF,
    );
    expect(assessment.observation?.measuredWidth).toBe(640);
    expect(assessment.gate.passed).toBe(false);
  });
});

describe("measureFrames", () => {
  it("returns nulls for an empty render", () => {
    expect(measureFrames([])).toEqual({ width: null, height: null });
  });

  it("reports a deviating frame instead of averaging", () => {
    const frames = [
      frame(0),
      { ...frame(1), width: 640, height: 480 },
      frame(2),
    ];
    expect(measureFrames(frames)).toEqual({ width: 640, height: 480 });
  });

  it("reports the shared size when every frame agrees", () => {
    expect(measureFrames([frame(0), frame(1)])).toEqual({
      width: 320,
      height: 240,
    });
  });
});
