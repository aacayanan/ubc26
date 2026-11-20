import { describe, expect, it } from "vitest";
import {
  buildChunkMessages,
  buildGenerationMessages,
  CONTINUATION_INSTRUCTION,
  extractRenderCode,
  FINAL_CHUNK_INSTRUCTION,
  hashMessages,
  MAX_SOURCE_CHARS,
  PROMPT_TEMPLATE_VERSION,
  toGenerationChallenge,
  withTokenFloor,
  DEFAULT_MAX_TOKENS,
  type GenerationChallenge,
} from "@/lib/server/services/llm/prompt";

const CHALLENGE: GenerationChallenge = {
  title: "Isometric donut spinning in a loop",
  prompt: "Render a donut in an isometric projection, spinning once per loop.",
  styleConstraints:
    "Isometric projection, two flat fills — magenta and violet — on a void background. No gradients, no text.",
  entryPoint: "drawFrame",
  targetDurationMs: 1200,
  frameCount: 36,
  frameWidth: 320,
  frameHeight: 240,
  starterCode: "function drawFrame(t, ctx, canvas) {\n  // draw here\n}",
};

describe("buildGenerationMessages", () => {
  it("is identical for every model — there is no model input at all", () => {
    // The builder takes no model, so two calls with the same challenge cannot
    // differ. This locks in the F16 fairness rule structurally.
    const a = buildGenerationMessages(CHALLENGE);
    const b = buildGenerationMessages(CHALLENGE);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toMatch(/gpt|claude|gemini|deepseek/i);
  });

  it("asks for a renderer, not a Python solution", () => {
    const [system] = buildGenerationMessages(CHALLENGE);
    expect(system.content).toContain("JavaScript");
    // The system prompt describes the calling convention generically; the
    // concrete name belongs in the user message, per challenge.
    expect(system.content).toContain("entryPoint(t, ctx, canvas)");
    // The retired format's vocabulary must not return (CLAUDE.md).
    expect(system.content).not.toMatch(/python/i);
    expect(system.content).not.toMatch(/speed|code length|correctness/i);
  });

  it("forbids the non-determinism a model reaches for by default", () => {
    // F14 acceptance: frames are captured at explicit time steps, so a
    // solution must be a pure function of t.
    const [system] = buildGenerationMessages(CHALLENGE);
    expect(system.content).toMatch(/Date\.now\(\)/);
    expect(system.content).toMatch(/Math\.random\(\)/);
    expect(system.content).toMatch(/requestAnimationFrame/);
    expect(system.content).toMatch(/pure function of t/i);
  });

  it("carries the style constraints and the frame contract", () => {
    const [, user] = buildGenerationMessages(CHALLENGE);
    expect(user.content).toContain(CHALLENGE.styleConstraints);
    expect(user.content).toContain("320x240");
    expect(user.content).toContain("1200 ms");
    expect(user.content).toContain("36 frames");
    expect(user.content).toContain("function drawFrame(t, ctx, canvas)");
  });

  it("includes the starter code as javascript", () => {
    const [, user] = buildGenerationMessages(CHALLENGE);
    expect(user.content).toContain("```javascript");
  });

  it("omits the starter-code section when there is none", () => {
    const [, user] = buildGenerationMessages({
      ...CHALLENGE,
      starterCode: "   ",
    });
    expect(user.content).not.toContain("```javascript");
  });

  it("exports a bump-able template version", () => {
    expect(PROMPT_TEMPLATE_VERSION).toBe("render-v3");
  });
});

describe("toGenerationChallenge", () => {
  it("strips the reference implementation — the answer key never reaches a model", () => {
    const SENTINEL = "REFERENCE_IMPL_SENTINEL_42";
    const brief = {
      ...CHALLENGE,
      referenceImpl: SENTINEL,
      judgeRubric: [{ id: "x", question: SENTINEL, weight: 1 }],
      id: "brief-1",
      slug: "isometric-donut",
      version: 1,
    };

    const challenge = toGenerationChallenge(brief);
    const messages = buildGenerationMessages(challenge);

    expect(JSON.stringify(messages)).not.toContain(SENTINEL);
    expect(challenge).not.toHaveProperty("referenceImpl");
    expect(challenge).not.toHaveProperty("judgeRubric");
  });
});

describe("hashMessages", () => {
  it("is deterministic and changes with the prompt text", () => {
    const base = hashMessages(buildGenerationMessages(CHALLENGE));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMessages(buildGenerationMessages(CHALLENGE))).toBe(base);

    const changed = hashMessages(
      buildGenerationMessages({ ...CHALLENGE, prompt: "Something else" }),
    );
    expect(changed).not.toBe(base);
  });

  it("changes when the style constraints change", () => {
    // A brief edit must produce a different fingerprint, or two rounds would
    // look identical in the execution record.
    const base = hashMessages(buildGenerationMessages(CHALLENGE));
    const changed = hashMessages(
      buildGenerationMessages({ ...CHALLENGE, styleConstraints: "Anything." }),
    );
    expect(changed).not.toBe(base);
  });
});

describe("extractRenderCode", () => {
  it("takes the body of a fenced javascript block", () => {
    const result = extractRenderCode(
      "Sure! Here you go:\n```javascript\nfunction drawFrame(t, ctx) {\n  ctx.fillRect(0, 0, 1, 1);\n}\n```\nText after.",
      "drawFrame",
    );
    expect(result).toEqual({
      ok: true,
      code: "function drawFrame(t, ctx) {\n  ctx.fillRect(0, 0, 1, 1);\n}",
    });
  });

  it("accepts a bare fence", () => {
    const result = extractRenderCode(
      "```\nfunction drawFrame(t, ctx) {}\n```",
      "drawFrame",
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a js-tagged fence", () => {
    const result = extractRenderCode(
      "```js\nfunction drawFrame(t, ctx) {}\n```",
      "drawFrame",
    );
    expect(result.ok).toBe(true);
  });

  it("slices plain prose down to the function declaration", () => {
    const result = extractRenderCode(
      "Here is the renderer.\nfunction drawFrame(t, ctx) {\n  ctx.fillRect(0, 0, 1, 1);\n}",
      "drawFrame",
    );
    expect(result).toEqual({
      ok: true,
      code: "function drawFrame(t, ctx) {\n  ctx.fillRect(0, 0, 1, 1);\n}",
    });
  });

  it("accepts an arrow function assigned to the entry point", () => {
    // A const arrow draws the same pixels as a declaration; failing a model on
    // the stylistic difference would be arbitrary.
    const result = extractRenderCode(
      "const drawFrame = (t, ctx) => { ctx.fillRect(0, 0, 1, 1); };",
      "drawFrame",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an answer with no entry point", () => {
    expect(extractRenderCode("I cannot help with that.", "drawFrame")).toEqual({
      ok: false,
      reason: "no_function",
    });
  });

  it("does not match a different function name", () => {
    expect(extractRenderCode("function other(t, ctx) {}", "drawFrame")).toEqual(
      {
        ok: false,
        reason: "no_function",
      },
    );
  });

  it("rejects empty output", () => {
    expect(extractRenderCode("   ", "drawFrame")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("rejects output over the source size limit", () => {
    const huge = `function drawFrame(t, ctx) {}\n// ${"x".repeat(MAX_SOURCE_CHARS)}`;
    expect(extractRenderCode(huge, "drawFrame")).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("allows a source larger than the retired python limit", () => {
    // Regression guard: the F13 Python cap was 64 KiB. A three.js scene can
    // exceed that legitimately, and the render harness accepts 256 KiB.
    const big = `function drawFrame(t, ctx) {}\n// ${"x".repeat(70 * 1024)}`;
    expect(extractRenderCode(big, "drawFrame").ok).toBe(true);
  });
});

describe("withTokenFloor", () => {
  it("adds a max_tokens when the model config sets none", () => {
    // Measured: the identical brief ran 5.2 s with a cap and past 100 s
    // without one, because a reasoning model keeps generating until stopped.
    expect(withTokenFloor({ temperature: 0 })).toEqual({
      temperature: 0,
      max_tokens: DEFAULT_MAX_TOKENS,
    });
    expect(withTokenFloor(undefined)).toEqual({
      max_tokens: DEFAULT_MAX_TOKENS,
    });
  });

  it("never overrides an explicit max_tokens", () => {
    // A model that genuinely needs a larger budget stays configurable.
    expect(withTokenFloor({ max_tokens: 20_000 })).toEqual({
      max_tokens: 20_000,
    });
  });

  it("does not mutate the caller's config object", () => {
    const config = { temperature: 0 };
    withTokenFloor(config);
    expect(config).toEqual({ temperature: 0 });
  });
});

describe("buildChunkMessages", () => {
  const base = { challenge: CHALLENGE, codeSoFar: "", chunkIndex: 0 };

  it("asks chunk 0 exactly as an unchunked turn would", () => {
    expect(
      buildChunkMessages({
        ...base,
        isFinalChunk: false,
        completeSoFar: false,
      }),
    ).toEqual(buildGenerationMessages(CHALLENGE));
  });

  it("continues a model that has not finished", () => {
    const messages = buildChunkMessages({
      challenge: CHALLENGE,
      codeSoFar: "function drawFrame(t) {",
      chunkIndex: 1,
      isFinalChunk: false,
      completeSoFar: false,
    });

    expect(messages.at(-2)).toEqual({
      role: "assistant",
      content: "function drawFrame(t) {",
    });
    expect(messages.at(-1)?.content).toBe(CONTINUATION_INSTRUCTION);
  });

  it("extends a model that already finished, in its remaining slots", () => {
    const messages = buildChunkMessages({
      challenge: CHALLENGE,
      codeSoFar: "function drawFrame(t) {}",
      chunkIndex: 2,
      isFinalChunk: false,
      completeSoFar: true,
    });

    const instruction = messages.at(-1)?.content as string;
    // Never "continue where you stopped": there is nothing left to continue.
    expect(instruction).not.toBe(CONTINUATION_INSTRUCTION);
    expect(instruction).not.toBe(FINAL_CHUNK_INSTRUCTION);
    // The capture is per chunk, so two extensions do not redeclare a const.
    expect(instruction).toContain("const __earlier2 = drawFrame;");
    // The model is told why a second declaration is wrong, not just told not to.
    expect(instruction).toMatch(/hoisted/);
  });

  it("gives each extension slot a distinct capture name", () => {
    const one = buildChunkMessages({
      challenge: CHALLENGE,
      codeSoFar: "function drawFrame(t) {}",
      chunkIndex: 1,
      isFinalChunk: false,
      completeSoFar: true,
    }).at(-1)?.content as string;
    const three = buildChunkMessages({
      challenge: CHALLENGE,
      codeSoFar: "function drawFrame(t) {}",
      chunkIndex: 3,
      isFinalChunk: true,
      completeSoFar: true,
    }).at(-1)?.content as string;

    expect(one).toContain("__earlier1");
    expect(three).toContain("__earlier3");
  });
});
