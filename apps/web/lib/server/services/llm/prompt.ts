import "server-only";

import { createHash } from "node:crypto";
import type { ChatMessage } from "@/lib/server/integrations/openrouter/client";

/**
 * The one prompt every model receives (F16 fairness rule, F33 re-scope).
 *
 * Models write a **renderer**: a JavaScript function the sandbox calls once per
 * frame. The pivot replaced Python coding challenges with visual briefs, and
 * this module is where the brief becomes instructions.
 *
 * Bump PROMPT_TEMPLATE_VERSION whenever the wording changes — the version and a
 * hash of the exact messages are stored per execution, so a run can be
 * reproduced even after this file is edited.
 */

export const PROMPT_TEMPLATE_VERSION = "render-v3";

/**
 * Mirrors the render harness' own cap (`sandbox/render/harness.mjs`).
 *
 * Deliberately larger than the retired F13 Python limit: a three.js scene is a
 * few hundred lines, and a 64 KB ceiling would truncate a legitimate answer.
 * The harness re-checks, so this is a courtesy bound, not the control.
 */
export const MAX_SOURCE_CHARS = 256 * 1024;

/**
 * Floor applied to a model's `max_tokens` when it sets none (F33).
 *
 * Measured: the same brief takes 5.2 s with a cap and runs past 100 s without
 * one, because these are reasoning-capable models that will keep generating
 * until someone stops them. Without this, a lineup row with an empty `config`
 * hangs until the client times out and the round forfeits for no model-driven
 * reason. Generous enough for reasoning plus a full renderer, small enough that
 * a runaway answer is bounded. Set per model in `llm_models.config`.
 */
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * Apply the token floor to a model's generation params.
 *
 * Only fills a gap: an explicit `max_tokens` always wins, so a model that
 * genuinely needs a larger budget can still be configured to have one.
 */
export function withTokenFloor(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged = { ...(params ?? {}) };
  if (typeof merged.max_tokens !== "number") {
    merged.max_tokens = DEFAULT_MAX_TOKENS;
  }
  return merged;
}

/**
 * What a model is told about the brief.
 *
 * Deliberately NOT `BriefRecord`: that row carries `referenceImpl` — a working
 * answer — and a type that could be passed here is a type that could leak the
 * answer into the prompt. This shape has no slot for it (F12/F16).
 */
export interface GenerationChallenge {
  title: string;
  prompt: string;
  styleConstraints: string;
  entryPoint: string;
  targetDurationMs: number;
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
  starterCode: string;
}

const SYSTEM_PROMPT = [
  "You are competing in a creative visual challenge. Write JavaScript that draws.",
  "",
  "Rules:",
  "- Reply with one complete JavaScript function and nothing else. No prose, no explanation.",
  "- Define the entry-point function given below. It is called once per frame as",
  "  entryPoint(t, ctx, canvas), where t is the time in milliseconds within the loop,",
  "  ctx is a Canvas 2D context, and canvas is the frame canvas.",
  "- Draw with the Canvas 2D API only. Do not call requestAnimationFrame, setTimeout,",
  "  setInterval or any animation loop: the caller owns the clock.",
  "- The function MUST be a pure function of t. Do not use Date.now(), Math.random(),",
  "  performance.now(), or anything else that differs between two runs. The same code",
  "  is rendered twice and the frames must match exactly.",
  "- The canvas is already the size given below. Do not resize it, and do not read or",
  "  write files, open network connections, or touch the DOM outside the canvas.",
  "- Clear the frame with a background fill before drawing; a frame that never draws",
  "  is a failed frame.",
  "- Do not include tests, example calls, or console.log.",
  "",
  "Ambition (this is a live showcase, watched as you write):",
  "- Build an elaborate, layered scene, not a sketch: several distinct visual",
  "  elements, each with its own motion, plus lighting, depth, texture or",
  "  particle detail. Use helper functions declared inside the entry point.",
  "- The finished function must be at least 450 lines long (roughly 5,000-6,000",
  "  tokens). That is longer than one reply allows, so the work is split across",
  "  several replies: start writing now and keep going until your reply is cut",
  "  off. Stopping mid-function is expected; you will be asked to continue",
  "  exactly where you stopped. Do not close the function early, and do not",
  "  compress the scene to fit a single reply.",
].join("\n");

function userPrompt(challenge: GenerationChallenge): string {
  const parts = [
    `# Brief: ${challenge.title}`,
    "",
    challenge.prompt,
    "",
    "## Style constraints (non-negotiable)",
    "",
    challenge.styleConstraints,
    "",
    "## Contract",
    "",
    `- Entry point: function ${challenge.entryPoint}(t, ctx, canvas)`,
    `- Canvas: ${challenge.frameWidth}x${challenge.frameHeight} pixels`,
    `- Loop length: ${challenge.targetDurationMs} ms, captured as ${challenge.frameCount} frames`,
    `- Frame times: frame i is drawn at t = i / (${challenge.frameCount} - 1) * ${challenge.targetDurationMs} ms`,
  ];

  if (challenge.starterCode.trim() !== "") {
    parts.push(
      "",
      "## Starter code (optional scaffolding, not a constraint)",
      "",
      "```javascript",
      challenge.starterCode.trimEnd(),
      "```",
    );
  }

  return parts.join("\n");
}

export function buildGenerationMessages(
  challenge: GenerationChallenge,
): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt(challenge) },
  ];
}

// ---------------------------------------------------------------------------
// Chunked generation (F17).
//
// The audience watches the renderer take shape, so generation is split. The
// first chunk is the same request as an unchunked turn; each later chunk carries
// the code so far and asks only for the next piece.
//
// The policy — token cap, chunk count, template version — is identical for every
// model in a round (REQUIREMENTS.md non-negotiable #10). It lives in
// `evaluation/chunk-policy.ts` rather than here so it can be recorded on the
// execution as data.
// ---------------------------------------------------------------------------

/**
 * The instruction appended for a continuation chunk.
 *
 * Deliberately explicit that the reply is *concatenated* verbatim: a model that
 * re-emits the whole function or adds `\`\`\`` fences would break the join, and
 * the failure would look like a syntax error rather than a protocol mistake.
 */
export const CONTINUATION_INSTRUCTION = [
  "You are continuing the same function from the previous reply.",
  "Reply with ONLY the next piece of code, starting exactly where the previous piece stopped.",
  "Do not repeat any code you already wrote. Do not add prose, comments about this instruction, or code fences.",
].join("\n");

/** The final chunk's instruction: later chunks are never requested. */
export const FINAL_CHUNK_INSTRUCTION = [
  "You are continuing the same function from the previous reply.",
  "Reply with ONLY the remaining code, starting exactly where the previous piece stopped, and finish the function.",
  "Do not repeat any code you already wrote. Do not add prose or code fences.",
].join("\n");

/**
 * The instruction for a model that is already *done* but still has chunks left.
 *
 * Models do not spend a fixed number of replies. One will answer the whole brief
 * in a single chunk and return `finish_reason: stop`, while two rivals keep
 * writing. Left alone that asymmetry is not just cosmetic: the chunk counter
 * reads "1 of 4" for one model and "4 of 4" for the others, and — because a
 * finished model closes live betting (F7/F11) — the early one ends the betting
 * window while its rivals are still on their first chunk.
 *
 * So every model fills every chunk slot. For a model that already produced a
 * complete renderer, the remaining slots ask it to *layer more onto the scene*
 * rather than to continue a function that has already been closed.
 *
 * The layering idiom is spelled out for two reasons. `drawFrame` is already a
 * `function` declaration, so the natural-looking `function drawFrame(...)` a
 * model would write is hoisted and replaces the original *before* anything can
 * capture it — the scene would call itself forever. And the captured binding is
 * named per chunk, because two chunks both declaring `const __earlier` would be
 * a redeclaration error in the same script scope.
 *
 * This works because the render harness looks `window[entryPoint]` up at call
 * time (see `sandbox/render/harness.mjs`): reassigning the entry point is the
 * one way appended code can change what is drawn.
 */
export function extensionInstruction(
  entryPoint: string,
  chunkIndex: number,
): string {
  const capture = `__earlier${chunkIndex}`;
  return [
    "You are continuing the same scene from the previous reply.",
    "The code so far already defines a complete, working renderer. Do not rewrite, repeat or reformat it.",
    "Reply with ONLY code to append to the end of the file, starting exactly where the previous reply stopped.",
    "Do not add prose, comments about this instruction, or code fences.",
    "",
    "Make the scene richer — more detail, more motion, more lighting, depth or texture — and make",
    "that new detail render by layering a new definition over the existing one, in exactly this shape:",
    "",
    `  const ${capture} = ${entryPoint};`,
    `  ${entryPoint} = function (t, ctx, canvas) {`,
    `    ${capture}(t, ctx, canvas);`,
    "    // ... the additional drawing goes here",
    "  };",
    "",
    `Use an assignment (\`${entryPoint} = function ...\`). Do not write a second`,
    `\`function ${entryPoint}(...)\` declaration: function declarations are hoisted, so it would replace the`,
    "original before it could be captured and the scene would call itself forever.",
  ].join("\n");
}

export interface ChunkGenerationInput {
  challenge: GenerationChallenge;
  /** Code accumulated from the chunks before this one. Empty for chunk 0. */
  codeSoFar: string;
  chunkIndex: number;
  isFinalChunk: boolean;
  /**
   * True when `codeSoFar` is already a complete renderer — the model finished
   * early. The chunk is then an extension (see `extensionInstruction`) rather
   * than a continuation.
   */
  completeSoFar: boolean;
}

/**
 * Build the messages for one chunk.
 *
 * Chunk 0 is byte-identical to `buildGenerationMessages`, so chunking changes
 * how a model is asked, never what it is asked. Later chunks keep the same
 * system prompt and brief (so the constraints are still in front of the model)
 * and append the code so far.
 *
 * A model that already finished has no "remaining code" and no next piece to
 * continue — asking either would get a confused reply or a re-emitted function.
 * Its remaining chunks get the extension instruction instead, so every model
 * fills the same number of slots and the chunk counter and betting cutoff see
 * one schedule rather than three.
 */
export function buildChunkMessages(input: ChunkGenerationInput): ChatMessage[] {
  const { challenge, codeSoFar, chunkIndex, isFinalChunk, completeSoFar } =
    input;

  const base = buildGenerationMessages(challenge);
  if (chunkIndex === 0) return base;

  const instruction = completeSoFar
    ? extensionInstruction(challenge.entryPoint, chunkIndex)
    : isFinalChunk
      ? FINAL_CHUNK_INSTRUCTION
      : CONTINUATION_INSTRUCTION;

  return [
    ...base,
    // Prior output is carried as the assistant's own turn: the model is
    // continuing its work, not being handed a stranger's code to patch.
    { role: "assistant", content: codeSoFar },
    { role: "user", content: instruction },
  ];
}

/**
 * Stable fingerprint of the exact messages sent, stored as `prompt_sha256` in
 * the execution's config snapshot. Named without "prompt" when logged because
 * the logger redacts any key matching /prompt/.
 */
export function hashMessages(messages: ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

export type CodeExtraction =
  | { ok: true; code: string }
  | { ok: false; reason: "empty" | "no_function" | "too_long" };

// A fenced block, with or without a language tag. The renderer is JavaScript,
// but models still occasionally label a fence `js`, `html` or nothing at all.
const FENCE_PATTERN = /```(?:javascript|js|html)?[ \t]*\r?\n([\s\S]*?)```/;

/**
 * A line that defines the entry point, in any of the forms a model reaches for.
 *
 * `function draw(t, ctx, canvas) {}` is what the prompt asks for, but a
 * `const draw = ...` arrow function draws the same pixels, so both are accepted
 * rather than failing a model on a stylistic technicality.
 */
function entryPointPattern(entryPoint: string): RegExp {
  const name = entryPoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^\\s*(?:export\\s+)?(?:` +
      `(?:async\\s+)?function\\s+${name}\\s*\\(` +
      `|(?:const|let|var)\\s+${name}\\s*=` +
      `|${name}\\s*=\\s*(?:async\\s*)?(?:function|\\()` +
      `)`,
  );
}

/**
 * Pull renderer source out of a model reply.
 *
 * Models wrap output in fences inconsistently and sometimes add a sentence
 * before or after. A fenced block wins; otherwise the text is taken from the
 * first line that defines the entry point. Everything else is reported as
 * malformed so the caller records an explicit failure instead of rendering
 * prose.
 */
export function extractRenderCode(
  content: string,
  entryPoint: string,
): CodeExtraction {
  if (content.trim() === "") return { ok: false, reason: "empty" };

  const fenced = FENCE_PATTERN.exec(content);
  let code = fenced ? fenced[1] : content;

  if (!fenced) {
    const lines = content.split("\n");
    const pattern = entryPointPattern(entryPoint);
    const anchor = lines.findIndex((line) => pattern.test(line));
    if (anchor === -1) return { ok: false, reason: "no_function" };
    code = lines.slice(anchor).join("\n");
  }

  code = code.trim();
  if (code === "") return { ok: false, reason: "empty" };
  if (code.length > MAX_SOURCE_CHARS) return { ok: false, reason: "too_long" };

  return { ok: true, code };
}

/**
 * Project a stored brief onto what a model may see.
 *
 * The one place `reference_impl` is stripped. Kept here so a caller cannot
 * accidentally pass the answer key along with the question.
 */
export function toGenerationChallenge(brief: {
  title: string;
  prompt: string;
  styleConstraints: string;
  entryPoint: string;
  targetDurationMs: number;
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
  starterCode: string;
}): GenerationChallenge {
  return {
    title: brief.title,
    prompt: brief.prompt,
    styleConstraints: brief.styleConstraints,
    entryPoint: brief.entryPoint,
    targetDurationMs: brief.targetDurationMs,
    frameCount: brief.frameCount,
    frameWidth: brief.frameWidth,
    frameHeight: brief.frameHeight,
    starterCode: brief.starterCode,
  };
}
