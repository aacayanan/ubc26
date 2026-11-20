import "server-only";

import type { StoredChunk } from "@ai-showdown/shared";

/**
 * Assembling and reading chunked generation (F17).
 *
 * Two jobs live here, both pure:
 *
 *   * **Join** — chunk sources are concatenated in index order to form the
 *     renderer. The join is what a resume depends on: an existing chunk is never
 *     re-requested, so the only way to reconstruct the full source is to read
 *     what was stored.
 *   * **Assess** — decide whether a partial source is probably a complete
 *     program yet. This decides whether a progressive preview is even worth
 *     rendering. A chunk that would not parse is *not* a failure: the audience
 *     sees the code growing and a "compiling…" state, and generation continues
 *     (REQUIREMENTS.md: a partial chunk must never fail the round).
 *
 * The assessment is a heuristic on purpose. It is the *preview* gate, not the
 * deterministic gate — the real verdict comes from rendering the finished
 * source in the sandbox (F14). Being wrong here costs a wasted preview render,
 * never a wrong result.
 */

/** Fence lines a model may wrap a chunk's code in. */
const FENCE_LINE = /^\s*```[A-Za-z0-9_-]*\s*$/;

/**
 * Remove code-fence lines from one chunk.
 *
 * Chunk 0 is extracted with the full `extractRenderCode` rules (it may also
 * carry prose). Continuations are asked to be bare code, but a model that fences
 * anyway would otherwise produce a source that cannot parse — which the audience
 * would see as a broken render rather than the model's mistake.
 *
 * Only blank lines are trimmed, never indentation: a continuation is joined to
 * the previous chunk verbatim, and stripping leading spaces would reformat code
 * the model wrote.
 */
export function stripFences(text: string): string {
  const lines = text.split("\n").filter((line) => !FENCE_LINE.test(line));

  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  return lines.join("\n");
}

/**
 * The source a round should judge, given every chunk a model wrote.
 *
 * Normally this is just the join. The exception is the extension path: a model
 * that answered the whole brief in one reply has a complete renderer at chunk 0
 * and spends its remaining slots layering more onto it. If one of those layers
 * is cut off mid-function, the joined source no longer parses — and without
 * this, that model would forfeit the deterministic gate on *decoration*, after
 * having already written a renderer that would have passed.
 *
 * So when the full join does not parse, the source falls back to the longest
 * prefix that the model itself declared finished (`finish_reason: stop`) and
 * that parses. That is a real answer the model completed, not a fabrication; a
 * partial chunk is never promoted. When no such prefix exists — the ordinary
 * truncated-continuation case — the full join is returned unchanged and the
 * gate decides, exactly as before.
 */
export function assembleFinalSource(
  chunks: readonly StoredChunk[],
  entryPoint: string,
): { source: string; truncatedToChunk: number | null } {
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const full = joinChunks(ordered);

  if (chunks.length <= 1 || assessPartialSource(full, entryPoint).parsable) {
    return { source: full, truncatedToChunk: null };
  }

  // Longest first: the closest the model got to its finished scene.
  for (let end = ordered.length - 1; end >= 1; end -= 1) {
    const last = ordered[end - 1];
    const declaredComplete =
      last.finishReason === null || last.finishReason === "stop";
    if (!declaredComplete) continue;

    const prefix = joinChunks(ordered.slice(0, end));
    if (assessPartialSource(prefix, entryPoint).parsable) {
      return { source: prefix, truncatedToChunk: last.chunkIndex };
    }
  }

  return { source: full, truncatedToChunk: null };
}

/**
 * Join stored chunks into the source they describe.
 *
 * Sorted by index regardless of read order. A separator is inserted unless the
 * accumulated source already ends in a newline — chunk 0 goes through
 * `extractRenderCode`, which trims its trailing whitespace, so keying the
 * decision on the left side alone keeps a line boundary from being lost (the
 * right-hand chunk's own indentation is preserved either way).
 */
export function joinChunks(chunks: readonly StoredChunk[]): string {
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);

  let source = "";
  for (const chunk of ordered) {
    if (source === "") {
      source = chunk.source;
      continue;
    }

    source += (source.endsWith("\n") ? "" : "\n") + chunk.source;
  }

  return source.trim();
}

export interface PartialSourceAssessment {
  /** True when the source is plausibly a complete, runnable renderer. */
  parsable: boolean;
  /** True when the entry point is defined at all. */
  hasEntryPoint: boolean;
  /** Plain-language reason when `parsable` is false; never shown as an error. */
  reason: string | null;
}

/**
 * Decide whether a partial source is worth rendering as a preview.
 *
 * Checks, in order of how cheaply they rule a source out: an entry point exists,
 * brackets balance, the source does not end inside a string or comment. Brackets
 * and strings are scanned with a small state machine so a `}` inside a string or
 * a template literal does not fool the count — the same mistake would show a
 * broken source as complete, which is the direction that wastes a render.
 */
export function assessPartialSource(
  source: string,
  entryPoint: string,
): PartialSourceAssessment {
  if (source.trim() === "") {
    return {
      parsable: false,
      hasEntryPoint: false,
      reason: "no code yet",
    };
  }

  if (!definesEntryPoint(source, entryPoint)) {
    return {
      parsable: false,
      hasEntryPoint: false,
      reason: "entry point not defined yet",
    };
  }

  const scan = scanStructure(source);

  if (scan.inString) {
    return {
      parsable: false,
      hasEntryPoint: true,
      reason: "unterminated string or template literal",
    };
  }

  if (scan.unclosed > 0) {
    return {
      parsable: false,
      hasEntryPoint: true,
      reason: "unclosed block",
    };
  }

  if (scan.unopened > 0) {
    return {
      parsable: false,
      hasEntryPoint: true,
      reason: "unbalanced brackets",
    };
  }

  return { parsable: true, hasEntryPoint: true, reason: null };
}

/** Whether the entry point is defined in any of the accepted forms. */
export function definesEntryPoint(source: string, entryPoint: string): boolean {
  const name = entryPoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^\\s*(?:export\\s+)?(?:` +
      `(?:async\\s+)?function\\s+${name}\\s*\\(` +
      `|(?:const|let|var)\\s+${name}\\s*=` +
      `|${name}\\s*=\\s*(?:async\\s*)?(?:function|\\()` +
      `)`,
    "m",
  ).test(source);
}

interface StructureScan {
  /** Bracket depth left open at end of source. */
  unclosed: number;
  /** Closing brackets with no opener. */
  unopened: number;
  /** True when the scan ends inside a string, template literal or comment. */
  inString: boolean;
}

/**
 * Scan bracket balance while ignoring brackets inside strings and comments.
 *
 * Not a parser — it does not understand regular-expression literals, so a `/`
 * regex containing a bracket can still mislead it. That is acceptable for a
 * preview gate: the finished source is rendered for real and the sandbox
 * decides, so a wrong "looks complete" only costs a preview render.
 */
function scanStructure(source: string): StructureScan {
  let depth = 0;
  let unopened = 0;
  let inString = false;

  let quote: string | null = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
        inString = false;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      inString = true;
      continue;
    }

    if (char === "{") depth += 1;
    else if (char === "}") {
      if (depth === 0) unopened += 1;
      else depth -= 1;
    }
  }

  return {
    // A trailing block comment is not a syntax error; an unterminated *string*
    // is, and so is a source that ends inside a template literal.
    inString,
    unclosed: depth,
    unopened,
  };
}
