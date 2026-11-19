import { describe, expect, it } from "vitest";
import {
  toSeedPayload,
  type BriefSeedDocument,
} from "@/lib/server/services/briefs/briefs";

const DOC: BriefSeedDocument = {
  slug: "isometric-donut",
  title: "Isometric donut",
  prompt: "Draw a donut.",
  styleConstraints: "Two flat fills, no gradients.",
  entryPoint: "drawFrame",
  targetDurationMs: 1200,
  frameCount: 36,
  frameWidth: 320,
  frameHeight: 240,
  deterministicChecks: [{ kind: "non_blank" }],
  judgeRubric: [{ id: "subject", question: "Is it a donut?", weight: 1 }],
  starterCode: "function drawFrame() {}",
  referenceImpl: "function drawFrame() {}",
};

describe("toSeedPayload", () => {
  it("maps every camelCase field to its snake_case column", () => {
    const payload = toSeedPayload(DOC);
    expect(payload).toMatchObject({
      slug: "isometric-donut",
      style_constraints: "Two flat fills, no gradients.",
      entry_point: "drawFrame",
      target_duration_ms: 1200,
      frame_count: 36,
      frame_width: 320,
      frame_height: 240,
      starter_code: "function drawFrame() {}",
      reference_impl: "function drawFrame() {}",
      language: "javascript",
    });
  });

  it("passes the checks and rubric through unchanged", () => {
    const payload = toSeedPayload(DOC);
    expect(payload.deterministic_checks).toEqual(DOC.deterministicChecks);
    expect(payload.judge_rubric).toEqual(DOC.judgeRubric);
  });

  it("defaults starter_code to an empty string", () => {
    const { starterCode, ...withoutStarter } = DOC;
    expect(starterCode).toBeDefined();
    expect(toSeedPayload(withoutStarter).starter_code).toBe("");
  });

  it("always seeds as javascript, never python", () => {
    expect(toSeedPayload(DOC).language).toBe("javascript");
  });
});
