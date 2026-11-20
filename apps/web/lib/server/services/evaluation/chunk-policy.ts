import "server-only";

import type { ChunkPolicy } from "@ai-showdown/shared";
import { ConfigurationError } from "@/lib/server/errors/app-error";
import { PROMPT_TEMPLATE_VERSION } from "@/lib/server/services/llm/prompt";

/**
 * The chunking policy (F17).
 *
 * One object, read from environment, that every model in every round receives
 * identically. It is recorded on each generation execution's `config` snapshot,
 * so "every model got the same chunk policy and token cap"
 * (REQUIREMENTS.md non-negotiable #10) is checkable against a stored run rather
 * than asserted from code that has since changed.
 *
 * The defaults are chosen for the demo's 2–3 minute budget, not for output
 * quality: four chunks of 1536 tokens (the same ~6k budget) is enough for a Canvas renderer and keeps
 * a round's wall-clock inside the window. Four equal chunks also make the
 * SOL rounds' 75% betting cutoff land on a chunk boundary when chunks run full.
 */

/**
 * Bump when the wording of the chunk instructions changes (see prompt.ts).
 *
 * chunk-v2: every model fills every chunk slot; a model that finishes early gets
 * the extension instruction for its remaining slots, so the chunk count and the
 * SOL betting cutoff are the same schedule for all competitors.
 */
export const CHUNK_POLICY_VERSION = "chunk-v2";

export const DEFAULT_CHUNK_POLICY: ChunkPolicy = {
  maxTokensPerChunk: 1536,
  maxChunks: 4,
  // The template version pins which instruction wording produced a chunk. The
  // continuation wording is versioned with the base prompt, so this names both.
  promptTemplateVersion: `${PROMPT_TEMPLATE_VERSION}+${CHUNK_POLICY_VERSION}`,
};

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * The policy for this deployment.
 *
 * Read on demand, not at module load, matching the rest of `lib/config`: a
 * missing or malformed value should break the pipeline, never page rendering.
 */
export function getChunkPolicy(): ChunkPolicy {
  const maxChunks = readPositiveInt(
    "CHUNK_MAX_CHUNKS",
    DEFAULT_CHUNK_POLICY.maxChunks,
  );

  // More than a handful of chunks is not a longer renderer, it is a model
  // rambling — and every extra chunk is another render in the demo budget.
  if (maxChunks > 8) {
    throw new ConfigurationError("CHUNK_MAX_CHUNKS must be at most 8");
  }

  return {
    maxTokensPerChunk: readPositiveInt(
      "CHUNK_MAX_TOKENS",
      DEFAULT_CHUNK_POLICY.maxTokensPerChunk,
    ),
    maxChunks,
    promptTemplateVersion: DEFAULT_CHUNK_POLICY.promptTemplateVersion,
  };
}

/**
 * The generation params for one chunk of one model.
 *
 * Starts from the model's catalog config (temperature and so on) and replaces
 * `max_tokens` with the policy cap. The cap is the fairness rule, so a model's
 * own `config.max_tokens` must not be able to raise it — a row configured with
 * 8192 would otherwise get four times the generation budget of its rivals.
 */
export function chunkParams(
  modelConfig: Record<string, unknown>,
  policy: ChunkPolicy,
): Record<string, unknown> {
  return {
    ...modelConfig,
    max_tokens: policy.maxTokensPerChunk,
  };
}
