import { describe, expect, it } from "vitest";
import {
  assembleFinalSource,
  assessPartialSource,
  definesEntryPoint,
  joinChunks,
  stripFences,
} from "@/lib/server/services/evaluation/source-assembly";

/**
 * F17 source assembly.
 *
 * Two properties matter and are tested directly: a join is faithful (a resume
 * must reconstruct exactly what was generated), and the partial-source
 * assessment is conservative about "complete" — a source is only rendered as a
 * preview when it plausibly parses, and a wrong judgement here costs a preview
 * render, never a round.
 */

describe("joinChunks", () => {
  it("concatenates in index order regardless of read order", () => {
    const joined = joinChunks([
      { chunkIndex: 2, source: "  return;\n}" },
      { chunkIndex: 0, source: "function drawFrame(t, ctx) {\n" },
      { chunkIndex: 1, source: "  ctx.fillRect(0, 0, 1, 1);\n" },
    ]);

    expect(joined).toBe(
      "function drawFrame(t, ctx) {\n  ctx.fillRect(0, 0, 1, 1);\n  return;\n}",
    );
  });

  it("does not double a newline that is already there", () => {
    const joined = joinChunks([
      { chunkIndex: 0, source: "const a = 1;\n" },
      { chunkIndex: 1, source: "const b = 2;" },
    ]);

    expect(joined).toBe("const a = 1;\nconst b = 2;");
  });

  it("separates chunks that would otherwise fuse two tokens", () => {
    const joined = joinChunks([
      { chunkIndex: 0, source: "const a = b" },
      { chunkIndex: 1, source: "+ c;" },
    ]);

    expect(joined).toBe("const a = b\n+ c;");
  });

  it("returns empty for no chunks", () => {
    expect(joinChunks([])).toBe("");
  });
});

describe("assembleFinalSource", () => {
  const COMPLETE =
    "function drawFrame(t, ctx) {\n  ctx.fillRect(0, 0, 1, 1);\n}";
  const EXTENSION =
    "const __earlier1 = drawFrame;\ndrawFrame = function (t, ctx, canvas) {";

  it("joins normally when the full source parses", () => {
    const { source, truncatedToChunk } = assembleFinalSource(
      [
        {
          chunkIndex: 0,
          source: "function drawFrame(t) {",
          finishReason: "length",
        },
        { chunkIndex: 1, source: "}", finishReason: "stop" },
      ],
      "drawFrame",
    );

    expect(source).toBe("function drawFrame(t) {\n}");
    expect(truncatedToChunk).toBeNull();
  });

  it("falls back to the last finished prefix when a layer is cut off", () => {
    // Without this the model forfeits the gate on a truncated decoration,
    // having already written a renderer that would have passed.
    const { source, truncatedToChunk } = assembleFinalSource(
      [
        { chunkIndex: 0, source: COMPLETE, finishReason: "stop" },
        { chunkIndex: 1, source: EXTENSION, finishReason: "length" },
      ],
      "drawFrame",
    );

    expect(source).toBe(COMPLETE);
    expect(truncatedToChunk).toBe(0);
  });

  it("keeps a finished later layer and drops only the truncated one", () => {
    const layer2 = [
      "const __earlier2 = drawFrame;",
      "drawFrame = function (t, ctx, canvas) {",
      "  __earlier2(t, ctx, canvas);",
      "};",
    ].join("\n");

    const { source, truncatedToChunk } = assembleFinalSource(
      [
        { chunkIndex: 0, source: COMPLETE, finishReason: "stop" },
        {
          chunkIndex: 1,
          // A complete first layer: redefines the entry point and closes.
          source:
            "const __earlier1 = drawFrame;\ndrawFrame = function (t, ctx, canvas) {\n  __earlier1(t, ctx, canvas);\n};",
          finishReason: "stop",
        },
        { chunkIndex: 2, source: layer2, finishReason: "stop" },
        { chunkIndex: 3, source: EXTENSION, finishReason: "length" },
      ],
      "drawFrame",
    );

    expect(truncatedToChunk).toBe(2);
    expect(source).toContain("__earlier2");
  });

  it("never promotes a partial chunk that the model did not finish", () => {
    // The ordinary truncated-continuation case: nothing was ever complete, so
    // the full source is returned unchanged and the gate decides as usual.
    const { source, truncatedToChunk } = assembleFinalSource(
      [
        {
          chunkIndex: 0,
          source: "function drawFrame(t) {",
          finishReason: "length",
        },
        {
          chunkIndex: 1,
          source: "  ctx.fillRect(0, 0, 1, 1);",
          finishReason: "length",
        },
      ],
      "drawFrame",
    );

    expect(truncatedToChunk).toBeNull();
    expect(source).toBe("function drawFrame(t) {\n  ctx.fillRect(0, 0, 1, 1);");
  });
});

describe("stripFences", () => {
  it("removes fence lines a model wraps a continuation in", () => {
    const text = "```javascript\n  ctx.fillRect(0,0,1,1);\n```\n";
    expect(stripFences(text)).toBe("  ctx.fillRect(0,0,1,1);");
  });

  it("leaves bare code untouched", () => {
    expect(stripFences("let x = 1;")).toBe("let x = 1;");
  });
});

describe("definesEntryPoint", () => {
  it("accepts the function form the prompt asks for", () => {
    expect(definesEntryPoint("function drawFrame(t, ctx) {", "drawFrame")).toBe(
      true,
    );
  });

  it("accepts an arrow function assigned to the entry point", () => {
    expect(
      definesEntryPoint("const drawFrame = (t, ctx) => {", "drawFrame"),
    ).toBe(true);
  });

  it("does not match an unrelated identifier", () => {
    expect(definesEntryPoint("function other(t) {}", "drawFrame")).toBe(false);
  });
});

describe("assessPartialSource", () => {
  it("reports no code as not yet parsable", () => {
    expect(assessPartialSource("", "drawFrame")).toEqual({
      parsable: false,
      hasEntryPoint: false,
      reason: "no code yet",
    });
  });

  it("reports a missing entry point before the model has written it", () => {
    const result = assessPartialSource("const x = 1;", "drawFrame");
    expect(result.hasEntryPoint).toBe(false);
    expect(result.parsable).toBe(false);
  });

  it("treats an unclosed block mid-generation as a compiling state", () => {
    const result = assessPartialSource(
      "function drawFrame(t, ctx) {\n  ctx.fillRect(0, 0, 1, 1);",
      "drawFrame",
    );

    expect(result.hasEntryPoint).toBe(true);
    expect(result.parsable).toBe(false);
    expect(result.reason).toBe("unclosed block");
  });

  it("accepts a complete function", () => {
    const source =
      "function drawFrame(t, ctx) {\n  ctx.fillRect(0, 0, 1, 1);\n}";
    expect(assessPartialSource(source, "drawFrame")).toEqual({
      parsable: true,
      hasEntryPoint: true,
      reason: null,
    });
  });

  it("ignores brackets inside strings when balancing", () => {
    const source = [
      "function drawFrame(t, ctx) {",
      '  ctx.fillStyle = "#05040A";',
      '  const s = "}";',
      "}",
    ].join("\n");

    expect(assessPartialSource(source, "drawFrame").parsable).toBe(true);
  });

  it("treats an unterminated string as not yet parsable", () => {
    const source = [
      "function drawFrame(t, ctx) {",
      '  ctx.fillStyle = "#05040',
    ].join("\n");

    const result = assessPartialSource(source, "drawFrame");
    expect(result.parsable).toBe(false);
    expect(result.reason).toBe("unterminated string or template literal");
  });

  it("ignores braces inside a line comment", () => {
    const source = [
      "function drawFrame(t, ctx) {",
      "  // a stray } should not close the block",
      "}",
    ].join("\n");

    expect(assessPartialSource(source, "drawFrame").parsable).toBe(true);
  });

  it("reports an unmatched closing bracket rather than passing it", () => {
    const source = "function drawFrame(t) {\n}\n}";
    const result = assessPartialSource(source, "drawFrame");
    expect(result.parsable).toBe(false);
    expect(result.reason).toBe("unbalanced brackets");
  });
});
