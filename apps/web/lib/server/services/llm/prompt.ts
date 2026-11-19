import "server-only";

import { createHash } from "node:crypto";
import type { ChatMessage } from "@/lib/server/integrations/openrouter/client";

/**
 * The one prompt every model receives (F16 fairness rule).
 *
 * `GenerationChallenge` deliberately has no test fields: hidden `expected_output`
 * values cannot reach a model through this module because there is nowhere to
 * put them. Bump PROMPT_TEMPLATE_VERSION whenever the wording changes — the
 * version and a hash of the exact messages are stored per execution, so a run
 * can be reproduced even after this file is edited.
 */

export const PROMPT_TEMPLATE_VERSION = "generation-v1";

/** Mirrors DEFAULT_JOB_LIMITS.maxSourceChars in the F13 contract. */
export const MAX_SOURCE_CHARS = 64 * 1024;

export interface GenerationChallenge {
  title: string;
  prompt: string;
  starterCode: string;
  entryPoint: string;
  language: "python";
}

const SYSTEM_PROMPT = [
  "You are competing in a programming challenge. Write a Python solution.",
  "",
  "Rules:",
  "- Reply with one complete Python file and nothing else. No prose, no explanation.",
  "- Define the entry-point function given below. It receives positional",
  "  arguments and returns a JSON-serialisable value.",
  "- Use only the Python standard library. Do not read or write files, open",
  "  network connections, spawn processes, or print anything.",
  "- Do not include tests, example calls, or a __main__ block.",
  "- The solution is graded on correctness, then speed, then length. Prefer a",
  "  clear, correct solution over a clever one.",
].join("\n");

function userPrompt(challenge: GenerationChallenge): string {
  const parts = [
    `# Challenge: ${challenge.title}`,
    "",
    challenge.prompt,
    "",
    `Entry point: def ${challenge.entryPoint}(...)`,
  ];

  if (challenge.starterCode.trim() !== "") {
    parts.push(
      "",
      "Starter code (optional scaffolding, not a constraint):",
      "```python",
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

const FENCE_PATTERN = /```(?:python|py)?[ \t]*\r?\n([\s\S]*?)```/;

/**
 * Pull Python source out of a model reply.
 *
 * Models wrap output in fences inconsistently and sometimes add a sentence
 * before or after. A fenced block wins; otherwise the text is taken from the
 * first line that defines the entry point. Everything else is reported as
 * malformed so the caller records an explicit failure instead of sandboxing
 * prose.
 */
export function extractPythonCode(
  content: string,
  entryPoint: string,
): CodeExtraction {
  if (content.trim() === "") return { ok: false, reason: "empty" };

  const fenced = FENCE_PATTERN.exec(content);
  let code = fenced ? fenced[1] : content;

  if (!fenced) {
    const lines = content.split("\n");
    const anchor = lines.findIndex((line) =>
      new RegExp(`^\\s*(async\\s+)?def\\s+${entryPoint}\\s*\\(`).test(line),
    );
    if (anchor === -1) return { ok: false, reason: "no_function" };
    code = lines.slice(anchor).join("\n");
  }

  code = code.trim();
  if (code === "") return { ok: false, reason: "empty" };
  if (code.length > MAX_SOURCE_CHARS) return { ok: false, reason: "too_long" };

  return { ok: true, code };
}
