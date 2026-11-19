import { describe, expect, it } from "vitest";
import type { DeterministicCheck, RenderedFrame } from "@ai-showdown/shared";
import {
  evaluateGate,
  REQUIRED_CHECK_KINDS,
  type RenderObservation,
} from "@/lib/server/services/evaluation/gate";

function frame(index: number, blank = false): RenderedFrame {
  return {
    index,
    png: "iVBORw0KGgo=",
    blank,
    distinctColors: blank ? 1 : 12,
    width: 320,
    height: 240,
  };
}

function observation(
  overrides: Partial<RenderObservation> = {},
): RenderObservation {
  return {
    exitCode: 0,
    pageError: null,
    frames: [frame(0), frame(1), frame(2)],
    frameWidth: 320,
    frameHeight: 240,
    measuredWidth: 320,
    measuredHeight: 240,
    ...overrides,
  };
}

const FULL: DeterministicCheck[] = [
  { kind: "process_exit", expect: 0 },
  { kind: "no_uncaught_error" },
  { kind: "frames_emitted", expect: 3 },
  { kind: "frame_dimensions", expect: "320x240" },
  { kind: "non_blank" },
];

describe("evaluateGate", () => {
  it("passes when every check holds", () => {
    const gate = evaluateGate(FULL, observation());
    expect(gate.passed).toBe(true);
    expect(gate.failureReason).toBeNull();
    expect(gate.checks).toHaveLength(FULL.length);
    expect(gate.checks.every((check) => check.passed)).toBe(true);
  });

  it("reports every check, not just the failing one", () => {
    const gate = evaluateGate(FULL, observation({ exitCode: 1 }));
    expect(gate.checks.map((check) => check.kind)).toEqual(
      REQUIRED_CHECK_KINDS,
    );
  });

  it("fails on a non-zero exit", () => {
    const gate = evaluateGate(FULL, observation({ exitCode: 2 }));
    expect(gate.passed).toBe(false);
    expect(gate.failureReason).toMatch(/exited with 2/);
  });

  it("fails on an uncaught page error", () => {
    const gate = evaluateGate(
      FULL,
      observation({ pageError: "TypeError: boom" }),
    );
    expect(gate.passed).toBe(false);
    expect(gate.failureReason).toContain("TypeError: boom");
  });

  it("fails when fewer frames were emitted than the brief requires", () => {
    const gate = evaluateGate(FULL, observation({ frames: [frame(0)] }));
    expect(gate.passed).toBe(false);
    expect(gate.failureReason).toMatch(/1 frames.*requires 3/);
  });

  it("fails when the measured dimensions differ from the brief", () => {
    const gate = evaluateGate(
      FULL,
      observation({ measuredWidth: 640, measuredHeight: 480 }),
    );
    expect(gate.passed).toBe(false);
    expect(gate.failureReason).toMatch(/640x480.*320x240/);
  });

  it("fails frame_dimensions when a solution resized the canvas", () => {
    // Regression guard: the measured size comes from the frame the solution
    // produced, not from the brief. Before this, the check compared the
    // brief's dimensions against themselves and could never fail.
    const resized = observation({
      frames: [
        { ...frame(0), width: 640, height: 480 },
        { ...frame(1), width: 640, height: 480 },
        { ...frame(2), width: 640, height: 480 },
      ],
      measuredWidth: 640,
      measuredHeight: 480,
    });
    const gate = evaluateGate(FULL, resized);
    expect(gate.passed).toBe(false);
    expect(gate.checks.find((c) => c.kind === "frame_dimensions")?.passed).toBe(
      false,
    );
  });

  it("fails when every frame is blank", () => {
    const gate = evaluateGate(
      FULL,
      observation({ frames: [frame(0, true), frame(1, true), frame(2, true)] }),
    );
    expect(gate.passed).toBe(false);
    expect(gate.failureReason).toMatch(/flat colour/i);
  });

  it("passes non_blank when only some frames are blank", () => {
    // A brief may legitimately open on an empty canvas; the check is that the
    // render carries content somewhere, not that every frame does.
    const gate = evaluateGate(
      FULL,
      observation({ frames: [frame(0, true), frame(1), frame(2)] }),
    );
    expect(gate.passed).toBe(true);
  });

  it("fails non_blank when there are no frames at all", () => {
    const gate = evaluateGate(FULL, observation({ frames: [] }));
    expect(gate.passed).toBe(false);
  });

  it("treats a missing expect on frames_emitted as 'whatever arrived'", () => {
    const gate = evaluateGate(
      [{ kind: "frames_emitted" }],
      observation({ frames: [frame(0), frame(1)] }),
    );
    expect(gate.passed).toBe(true);
  });

  it("defaults a missing expect on process_exit to zero", () => {
    const gate = evaluateGate([{ kind: "process_exit" }], observation());
    expect(gate.passed).toBe(true);
  });

  it("fails an unknown check kind rather than ignoring it", () => {
    // A brief that promises a check the gate cannot run must not silently pass.
    const gate = evaluateGate(
      [{ kind: "made_up_check" as DeterministicCheck["kind"] }],
      observation(),
    );
    expect(gate.passed).toBe(false);
    expect(gate.failureReason).toMatch(/Unknown check kind/);
  });

  it("is deterministic — the same inputs give the same verdict", () => {
    const a = evaluateGate(FULL, observation());
    const b = evaluateGate(FULL, observation());
    expect(a).toEqual(b);
  });
});
