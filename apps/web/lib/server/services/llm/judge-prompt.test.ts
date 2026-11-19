import { describe, expect, it } from "vitest";
import type { JudgeCriterion } from "@ai-showdown/shared";
import {
  buildJudgeMessages,
  hashRubric,
  parseJudgeReply,
  sampleFrames,
} from "@/lib/server/services/llm/judge-prompt";

/**
 * F31 judge prompt and parser.
 *
 * The load-bearing rule these tests keep: the judge's `conformed` is *derived*
 * from its per-criterion answers, and a reply that is not the expected object is
 * rejected outright. A partially-accepted ruling would make `conformed` mean
 * something different for each model, which is the guess F31 forbids.
 */

const RUBRIC: JudgeCriterion[] = [
  { id: "subject", question: "Is there a donut?", weight: 0.6 },
  { id: "motion", question: "Does it spin?", weight: 0.4 },
];

function reply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    conformed: true,
    reason: "It looks like a donut.",
    criteria: [
      { id: "subject", passed: true, reason: "A clear ring." },
      { id: "motion", passed: true, reason: "The hole moves." },
    ],
    ...overrides,
  });
}

describe("parseJudgeReply", () => {
  it("accepts a well-formed ruling", () => {
    const result = parseJudgeReply(reply(), RUBRIC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.ruling.conformed).toBe(true);
    expect(result.ruling.criteria).toHaveLength(2);
    expect(result.ruling.criteria[0].question).toBe("Is there a donut?");
  });

  it("copies each criterion's weight from the rubric onto the verdict", () => {
    // Weight is presentation data for the results view (F19): it comes from the
    // rubric, never from the reply, so a judge cannot inflate its own answer.
    const result = parseJudgeReply(reply(), RUBRIC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.ruling.criteria.map((c) => c.weight)).toEqual([0.6, 0.4]);
  });

  it("derives conformed from the criteria, not from the judge's field", () => {
    // The judge says conformed but marks a criterion failed. The criteria win:
    // a contradiction must not become a pass.
    const result = parseJudgeReply(
      reply({
        conformed: true,
        criteria: [
          { id: "subject", passed: true, reason: "ok" },
          { id: "motion", passed: false, reason: "static" },
        ],
      }),
      RUBRIC,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ruling.conformed).toBe(false);
  });

  it("reads a fenced JSON reply", () => {
    const fenced = "```json\n" + reply() + "\n```";
    expect(parseJudgeReply(fenced, RUBRIC).ok).toBe(true);
  });

  it("rejects an empty reply", () => {
    expect(parseJudgeReply("   ", RUBRIC)).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("rejects prose that is not JSON", () => {
    const result = parseJudgeReply("The model did fine, I think.", RUBRIC);
    expect(result).toEqual({ ok: false, reason: "not_json" });
  });

  it("rejects a reply missing a rubric criterion", () => {
    // Only one of two criteria answered: `conformed` would be ambiguous.
    const result = parseJudgeReply(
      reply({ criteria: [{ id: "subject", passed: true, reason: "ok" }] }),
      RUBRIC,
    );

    expect(result).toEqual({ ok: false, reason: "wrong_shape" });
  });

  it("rejects a criterion the rubric never asked for", () => {
    const result = parseJudgeReply(
      reply({
        criteria: [
          { id: "subject", passed: true, reason: "ok" },
          { id: "motion", passed: true, reason: "ok" },
          { id: "extra", passed: true, reason: "invented" },
        ],
      }),
      RUBRIC,
    );

    expect(result).toEqual({ ok: false, reason: "wrong_shape" });
  });

  it("rejects a duplicated criterion", () => {
    const result = parseJudgeReply(
      reply({
        criteria: [
          { id: "subject", passed: true, reason: "ok" },
          { id: "subject", passed: true, reason: "ok" },
        ],
      }),
      RUBRIC,
    );

    expect(result).toEqual({ ok: false, reason: "wrong_shape" });
  });

  it("rejects a missing reason", () => {
    const result = parseJudgeReply(reply({ reason: 123 }), RUBRIC);
    expect(result).toEqual({ ok: false, reason: "wrong_shape" });
  });
});

describe("sampleFrames", () => {
  const frames = Array.from({ length: 12 }, (_, i) => i);

  it("samples evenly across the whole render, not just the start", () => {
    const sample = sampleFrames(frames, 4);
    expect(sample[0]).toBe(0);
    expect(sample[sample.length - 1]).toBe(11);
  });

  it("returns every frame when there are fewer than requested", () => {
    expect(sampleFrames([1, 2], 6)).toEqual([1, 2]);
  });

  it("returns empty for an empty render", () => {
    expect(sampleFrames([], 6)).toEqual([]);
  });
});

describe("buildJudgeMessages", () => {
  it("embeds frames as base64 data URLs and carries the rubric", () => {
    const messages = buildJudgeMessages({
      brief: {
        title: "Isometric donut",
        prompt: "Draw a donut.",
        styleConstraints: "Two fills.",
        judgeRubric: RUBRIC,
      },
      frames: [
        {
          index: 0,
          png: "iVBORw0KGgo=",
          blank: false,
          distinctColors: 8,
          width: 320,
          height: 240,
        },
      ],
    });

    const user = messages.find((message) => message.role === "user");
    expect(user).toBeDefined();
    if (!Array.isArray(user?.content))
      throw new Error("expected content array");

    const text = user.content.find((part) => part.type === "text");
    const image = user.content.find((part) => part.type === "image_url");

    expect(text && "text" in text && text.text).toContain("Is there a donut?");
    expect(image && "image_url" in image && image.image_url.url).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });
});

describe("hashRubric", () => {
  it("is stable for the same rubric and changes when it changes", () => {
    expect(hashRubric(RUBRIC)).toBe(hashRubric(RUBRIC));
    expect(hashRubric(RUBRIC)).not.toBe(hashRubric(RUBRIC.slice(0, 1)));
  });
});
