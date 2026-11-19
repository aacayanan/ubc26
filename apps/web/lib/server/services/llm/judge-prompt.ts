import "server-only";

import { createHash } from "node:crypto";
import type { JudgeCriterion, JudgeRuling } from "@ai-showdown/shared";
import type { ChatMessage } from "@/lib/server/integrations/openrouter/client";
import type { BriefRecord } from "@/lib/server/services/briefs/briefs";
import type { StoredFrame } from "@/lib/server/services/evaluation/artifacts";

/**
 * The judge's prompt and answer parser (F31).
 *
 * The judge sees the brief, its rubric, and a sample of the model's captured
 * frames, and answers with one JSON object. Two things are deliberate:
 *
 *   * **The rubric is data.** The criteria come from the brief row, never from
 *     this file; adding a criterion is a seed edit. The rubric's hash is stored
 *     with the verdict so a ruling stays explainable after a brief is
 *     re-versioned.
 *   * **A non-answer is a typed failure, not a guess.** A reply that is not the
 *     expected object is reported as `unparseable` and the caller records
 *     `unavailable` — the judge never silently becomes a pass or a fail
 *     (F31 acceptance).
 *
 * Model-generated content never reaches this module: the frames and rubric are
 * both server-side. Only the *reply* is untrusted, and it is parsed, not
 * evaluated.
 */

export const JUDGE_PROMPT_VERSION = "judge-v1";

/** How many frames the judge sees. Small enough to fit a vision budget. */
export const JUDGE_SAMPLE_FRAMES = 6;

const SYSTEM_PROMPT = [
  "You are judging a competition in which models were asked to write a JavaScript",
  "renderer. You will see the brief, a rubric of criteria, and several frames of one",
  "model's render captured at evenly spaced times across its loop.",
  "",
  "Judge only what the frames show. Do not assume the code works; a frame that shows",
  "nothing is a failure on the criterion it should satisfy.",
  "",
  "Reply with ONE JSON object and nothing else, in exactly this shape:",
  '{ "conformed": <true|false>, "reason": "<one or two plain sentences>",',
  '  "criteria": [ { "id": "<criterion id>", "passed": <true|false>,',
  '                 "reason": "<one plain sentence for this criterion>" } ] }',
  "",
  "`conformed` must be true only when every criterion passed. Use the criterion ids",
  "exactly as given. Do not add a summary criterion.",
].join("\n");

/**
 * Evenly spaced frames across the render.
 *
 * Even spacing means the sample covers the whole loop, so a render that is
 * correct only at the start cannot pass on a head-heavy sample. A render with
 * fewer frames than requested is sampled entirely.
 */
export function sampleFrames<T>(frames: readonly T[], count: number): T[] {
  if (count <= 0 || frames.length === 0) return [];
  if (frames.length <= count) return [...frames];

  const step = (frames.length - 1) / (count - 1);
  const picked: T[] = [];
  for (let i = 0; i < count; i += 1) {
    picked.push(frames[Math.round(i * step)]);
  }
  return picked;
}

/** Stable fingerprint of a brief's rubric, stored with each ruling. */
export function hashRubric(rubric: readonly JudgeCriterion[]): string {
  return createHash("sha256").update(JSON.stringify(rubric)).digest("hex");
}

export interface JudgeMessagesInput {
  brief: Pick<
    BriefRecord,
    "title" | "prompt" | "styleConstraints" | "judgeRubric"
  >;
  frames: StoredFrame[];
}

/**
 * Build the vision request.
 *
 * Frames are base64 PNGs stored without a data-URL prefix (F14); the image
 * content part needs the prefix, so it is added here — one place, so a caller
 * cannot forget and send an image the provider rejects. Images are embedded
 * rather than linked because the judge may run on a host with no egress.
 */
export function buildJudgeMessages(input: JudgeMessagesInput): ChatMessage[] {
  const { brief, frames } = input;

  const rubric = brief.judgeRubric
    .map(
      (criterion) =>
        `- ${criterion.id} (weight ${criterion.weight}): ${criterion.question}`,
    )
    .join("\n");

  const summary = [
    `# Brief: ${brief.title}`,
    "",
    brief.prompt,
    "",
    "## Style constraints",
    "",
    brief.styleConstraints,
    "",
    "## Rubric",
    "",
    rubric,
    "",
    `You are seeing ${frames.length} frames from this model's render, evenly spaced across its loop.`,
  ].join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: summary },
        ...frames.map((frame) => ({
          type: "image_url" as const,
          image_url: { url: `data:image/png;base64,${frame.png}` },
        })),
      ],
    },
  ];
}

// ```json … ``` or a bare object. Asking for bare JSON does not guarantee it.
const FENCE = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/;

export type JudgeParseResult =
  | { ok: true; ruling: JudgeRuling }
  | { ok: false; reason: "empty" | "not_json" | "wrong_shape" };

/**
 * Parse the judge's reply into a ruling.
 *
 * The ruling's `criteria` are checked against the rubric: an answer that omits
 * a criterion or invents one is rejected as the wrong shape rather than
 * partially accepted, because a partial ruling would make `conformed` mean
 * something different for each model.
 */
export function parseJudgeReply(
  content: string,
  rubric: readonly JudgeCriterion[],
): JudgeParseResult {
  if (content.trim() === "") return { ok: false, reason: "empty" };

  const fenced = FENCE.exec(content);
  const jsonText = (fenced ? fenced[1] : content).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: "not_json" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "wrong_shape" };
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.conformed !== "boolean") {
    return { ok: false, reason: "wrong_shape" };
  }
  if (typeof record.reason !== "string") {
    return { ok: false, reason: "wrong_shape" };
  }
  if (!Array.isArray(record.criteria)) {
    return { ok: false, reason: "wrong_shape" };
  }

  const expectedIds = new Set(rubric.map((criterion) => criterion.id));
  const seen = new Set<string>();
  const criteria: JudgeRuling["criteria"] = [];

  for (const entry of record.criteria) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, reason: "wrong_shape" };
    }

    const item = entry as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.passed !== "boolean" ||
      typeof item.reason !== "string"
    ) {
      return { ok: false, reason: "wrong_shape" };
    }

    if (!expectedIds.has(item.id) || seen.has(item.id)) {
      return { ok: false, reason: "wrong_shape" };
    }

    seen.add(item.id);
    const criterion = rubric.find((entry) => entry.id === item.id);

    criteria.push({
      id: item.id,
      question: criterion?.question ?? "",
      // The weight comes from the rubric, never from the reply — the judge is
      // answering "did it pass?", not setting how much that answer counts.
      weight: criterion?.weight ?? 0,
      passed: item.passed,
      reason: item.reason,
    });
  }

  // Every rubric criterion must be answered; missing one makes `conformed`
  // ambiguous, which is exactly the guess F31 forbids.
  if (seen.size !== expectedIds.size) {
    return { ok: false, reason: "wrong_shape" };
  }

  // `conformed` is the conjunction of the criteria — the score is derived from
  // the per-criterion answers, not from a number the judge could contradict.
  const conformed =
    criteria.length > 0 && criteria.every((criterion) => criterion.passed);

  return {
    ok: true,
    ruling: {
      conformed,
      reason: record.reason.trim(),
      criteria,
    },
  };
}
