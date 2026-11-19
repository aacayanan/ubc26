import { describe, expect, it } from "vitest";
import {
  buildGenerationMessages,
  extractPythonCode,
  hashMessages,
  MAX_SOURCE_CHARS,
  PROMPT_TEMPLATE_VERSION,
  type GenerationChallenge,
} from "@/lib/server/services/llm/prompt";

const CHALLENGE: GenerationChallenge = {
  title: "Sum a list",
  prompt: "Return the sum of a list of integers.",
  starterCode: "def total(values):\n    pass",
  entryPoint: "total",
  language: "python",
};

describe("buildGenerationMessages", () => {
  it("is identical for every model — there is no model input at all", () => {
    // The builder takes no model, so two calls with the same challenge cannot
    // differ. This locks in the F16 fairness rule structurally.
    const a = buildGenerationMessages(CHALLENGE);
    const b = buildGenerationMessages(CHALLENGE);
    expect(a).toEqual(b);
    // No model identity may leak into the prompt.
    expect(JSON.stringify(a)).not.toMatch(/gpt|claude|gemini|deepseek/i);
  });

  it("names the entry point and includes the starter code", () => {
    const [, user] = buildGenerationMessages(CHALLENGE);
    expect(user.content).toContain("def total(...)");
    expect(user.content).toContain("def total(values)");
  });

  it("bumps-able template version is exported", () => {
    expect(PROMPT_TEMPLATE_VERSION).toBe("generation-v1");
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

  it("never sees hidden expected output because the challenge type has no slot for it", () => {
    const SENTINEL = "EXPECTED_OUTPUT_SENTINEL_42";
    const messages = buildGenerationMessages(CHALLENGE);
    expect(JSON.stringify(messages)).not.toContain(SENTINEL);
  });
});

describe("extractPythonCode", () => {
  it("takes the body of a fenced python block", () => {
    const result = extractPythonCode(
      "Sure! Here you go:\n```python\ndef total(values):\n    return sum(values)\n```\nText after.",
      "total",
    );
    expect(result).toEqual({
      ok: true,
      code: "def total(values):\n    return sum(values)",
    });
  });

  it("accepts a bare fence", () => {
    const result = extractPythonCode(
      "```\ndef total(values):\n    return 0\n```",
      "total",
    );
    expect(result.ok).toBe(true);
  });

  it("slices plain prose down to the entry point", () => {
    const result = extractPythonCode(
      "Here is the solution.\ndef total(values):\n    return sum(values)",
      "total",
    );
    expect(result).toEqual({
      ok: true,
      code: "def total(values):\n    return sum(values)",
    });
  });

  it("rejects an answer with no entry point", () => {
    expect(extractPythonCode("I cannot help with that.", "total")).toEqual({
      ok: false,
      reason: "no_function",
    });
  });

  it("rejects empty output", () => {
    expect(extractPythonCode("   ", "total")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("rejects output over the sandbox size limit", () => {
    const huge = `def total(values):\n    return 0  # ${"x".repeat(MAX_SOURCE_CHARS)}`;
    expect(extractPythonCode(huge, "total")).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
});
