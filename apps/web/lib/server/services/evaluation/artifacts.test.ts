import { describe, expect, it } from "vitest";
import type { RenderedFrame } from "@ai-showdown/shared";
import { capFrames } from "@/lib/server/services/evaluation/artifacts";

function frame(index: number, pngChars: number): RenderedFrame {
  return {
    index,
    png: "a".repeat(pngChars),
    blank: false,
    distinctColors: 8,
    width: 320,
    height: 240,
  };
}

describe("capFrames", () => {
  it("keeps every frame that fits and reports no truncation", () => {
    const frames = [frame(0, 100), frame(1, 100), frame(2, 100)];
    const result = capFrames(frames, 1_000);
    expect(result.frames).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it("drops the tail once the budget is reached", () => {
    const frames = [frame(0, 100), frame(1, 100), frame(2, 100)];
    const result = capFrames(frames, 250);
    // 0 and 1 fit (200 bytes); 2 would exceed, so it is cut.
    expect(result.frames.map((f) => f.index)).toEqual([0, 1]);
    expect(result.truncated).toBe(true);
  });

  it("always keeps at least the first frame, even past the budget", () => {
    // A single frame larger than the whole limit: storing nothing tells a
    // viewer nothing, so the first frame survives regardless.
    const result = capFrames([frame(0, 5_000)], 1_000);
    expect(result.frames).toHaveLength(1);
  });

  it("is not truncated when the last frame lands exactly on the limit", () => {
    const frames = [frame(0, 100), frame(1, 100)];
    const result = capFrames(frames, 200);
    expect(result.frames).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("handles an empty frame set", () => {
    expect(capFrames([], 1_000)).toEqual({ frames: [], truncated: false });
  });
});
