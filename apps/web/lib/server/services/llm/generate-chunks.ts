import "server-only";

import type { ChunkPolicy, ExecutionStatus } from "@ai-showdown/shared";
import { runBackgroundTask } from "@/lib/server/background/task";
import { logger } from "@/lib/server/logging/logger";
import { getOpenRouterClient } from "@/lib/server/integrations/openrouter/config";
import type {
  GenerationFailure,
  OpenRouterClient,
} from "@/lib/server/integrations/openrouter/client";
import { markExecutionStatus } from "@/lib/server/services/evaluation/persist";
import { chunkParams } from "@/lib/server/services/evaluation/chunk-policy";
import {
  joinChunks,
  stripFences,
} from "@/lib/server/services/evaluation/source-assembly";
import {
  buildChunkMessages,
  extractRenderCode,
  hashMessages,
} from "@/lib/server/services/llm/prompt";
import type { LLMModelRecord } from "@/lib/server/services/llm/models";
import type { GenerationChallenge } from "@/lib/server/services/llm/prompt";
import {
  listChunks,
  upsertChunk,
  type ExistingChunk,
} from "@/lib/server/services/pipeline/pipeline-persist";

/**
 * Chunked generation for one model (F17).
 *
 * The pivot's promise is that the audience watches the renderer being written,
 * so generation is split into chunks with a per-chunk token cap. This module
 * owns the *chunk loop*; F16 owns the HTTP call and its retries, and
 * `llm/generate.ts` remains the unchunked single-shot path.
 *
 * Two properties the loop has to keep:
 *
 *   * **Resumable.** A chunk that already exists in `generation_chunks` is never
 *     re-requested. A restart reads the stored chunks, rebuilds the source, and
 *     continues from the next missing index — so an interrupted run neither
 *     duplicates records nor re-spends tokens on work already shown.
 *   * **Fair.** Every model in a round receives the identical policy object,
 *     recorded on its execution. The system prompt, brief and per-chunk cap are
 *     the same for all of them (REQUIREMENTS.md non-negotiable #10).
 *
 * A chunk that does not parse is not a failure here. The loop stores whatever
 * text came back, the caller renders a preview of the partial source, and only a
 * provider failure can end the model's run early.
 */

export interface GenerateChunksInput {
  roundId: string;
  /**
   * The execution row is created by the caller (so a preview callback can attach
   * to it before the first chunk), and generation writes into it.
   */
  executionId: string;
  model: LLMModelRecord;
  challenge: GenerationChallenge;
  policy: ChunkPolicy;
  correlationId: string;
  /** Called after each chunk is stored, with the execution id and full source. */
  onChunk?: (chunk: ExistingChunk, fullSource: string) => Promise<void> | void;
  /** Test seam; defaults to the configured client. */
  client?: OpenRouterClient;
}

export interface GenerateChunksResult {
  executionId: string;
  status: ExecutionStatus;
  /** True when the model forfeits the round (provider failure, not a bad render). */
  forfeited: boolean;
  /** The assembled source, or null when generation failed before any output. */
  code: string | null;
  /** How many chunks were requested this run (0 on a fully-resumed run). */
  chunksGenerated: number;
  /** How many chunks already existed before this run. */
  chunksResumed: number;
  failureReason: string | null;
}

// Mirrors F16's mapping: `unavailable` is infrastructure, not the model being bad.
const STATUS_BY_FAILURE: Record<
  GenerationFailure["failureKind"],
  ExecutionStatus
> = {
  timeout: "timeout",
  network: "unavailable",
  rate_limited: "error",
  provider_error: "error",
  model_unavailable: "unavailable",
  auth: "unavailable",
  insufficient_credits: "unavailable",
  invalid_request: "error",
  malformed_response: "error",
};

export async function generateChunks(
  input: GenerateChunksInput,
): Promise<GenerateChunksResult> {
  const { roundId, executionId, model, challenge, policy, correlationId } =
    input;

  return runBackgroundTask(
    {
      task: "llm.chunked_generation",
      correlationId,
      context: {
        roundId,
        modelId: model.id,
        modelSlug: model.slug,
        executionId,
        maxChunks: policy.maxChunks,
      },
    },
    async () => {
      const client = input.client ?? getOpenRouterClient();

      await markExecutionStatus(executionId, "running", {
        startedAt: new Date().toISOString(),
      });

      const existing = await listChunks(executionId);
      const chunksResumed = existing.length;

      if (chunksResumed > 0) {
        logger.info("llm.chunks.resumed", {
          correlationId,
          executionId,
          chunksResumed,
        });
      }

      let chunks = existing;
      let chunksGenerated = 0;
      let lastLatencyMs = 0;
      let attemptsUsed = 0;

      for (let index = 0; index < policy.maxChunks; index += 1) {
        const stored = chunks.find((chunk) => chunk.chunkIndex === index);

        if (stored) {
          // Resume path: this chunk already exists, so it is neither re-asked
          // for nor re-rendered. Its preview was published the first time.
          if (isTerminal(stored.finishReason)) break;
          continue;
        }

        const codeSoFar = joinChunks(chunks);
        const messages = buildChunkMessages({
          challenge,
          codeSoFar,
          chunkIndex: index,
          isFinalChunk: index === policy.maxChunks - 1,
        });

        const outcome = await client.generate({
          model: model.openrouterModelId,
          messages,
          params: chunkParams(model.config, policy),
          correlationId,
        });

        if (!outcome.ok) {
          const status = STATUS_BY_FAILURE[outcome.failureKind];
          const forfeited = outcome.exhausted
            ? outcome.attempts >= client.forfeitThreshold
            : true;

          await markExecutionStatus(executionId, status, {
            errorMessage: outcome.providerMessage.slice(0, 500),
            failureKind: outcome.failureKind,
            latencyMs: outcome.latencyMs,
            attemptCount: outcome.attempts,
            providerRequestId: outcome.providerRequestId,
            finishedAt: new Date().toISOString(),
          });

          logger.warn("llm.chunks.failed", {
            correlationId,
            executionId,
            chunkIndex: index,
            failureKind: outcome.failureKind,
            forfeited,
          });

          return {
            executionId,
            status,
            forfeited,
            // Whatever was generated before the failure is still real; the
            // caller decides whether it is enough to render. A forfeit is not
            // silently rewritten as partial credit (non-negotiable #9).
            code: null,
            chunksGenerated,
            chunksResumed,
            failureReason: outcome.providerMessage.slice(0, 500),
          };
        }

        lastLatencyMs = outcome.latencyMs;
        attemptsUsed += outcome.attempts;

        const source = chunkText(outcome.content, index, challenge.entryPoint);
        const chunk: ExistingChunk = {
          chunkIndex: index,
          source,
          finishReason: outcome.finishReason,
        };

        await upsertChunk({
          executionId,
          chunkIndex: index,
          source,
          promptTemplateVersion: policy.promptTemplateVersion,
          promptSha256: hashMessages(messages),
          finishReason: outcome.finishReason,
          outputTokens: outcome.usage?.outputUnits ?? null,
          attemptCount: outcome.attempts,
        });

        chunks = [...chunks, chunk];
        chunksGenerated += 1;

        const fullSource = joinChunks(chunks);
        await input.onChunk?.(chunk, fullSource);

        logger.info("llm.chunks.generated", {
          correlationId,
          executionId,
          chunkIndex: index,
          finishReason: outcome.finishReason,
          outputTokens: outcome.usage?.outputUnits ?? null,
        });

        // `stop` is the model saying it is done. `length` means it hit the cap,
        // which is exactly the case the next chunk exists for.
        if (isTerminal(outcome.finishReason)) break;
      }

      const code = joinChunks(chunks);

      await markExecutionStatus(executionId, "succeeded", {
        solutionCode: code,
        latencyMs: lastLatencyMs,
        attemptCount: Math.max(1, attemptsUsed),
        finishedAt: new Date().toISOString(),
      });

      logger.info("llm.chunks.succeeded", {
        correlationId,
        executionId,
        chunks: chunks.length,
        chunksGenerated,
        chunksResumed,
        codeLength: code.length,
      });

      return {
        executionId,
        status: "succeeded" as const,
        forfeited: false,
        code,
        chunksGenerated,
        chunksResumed,
        failureReason: null,
      };
    },
  );
}

/**
 * Is this chunk the model's last word?
 *
 * Only `stop` (and a null reason, which some providers omit on a clean finish)
 * ends the loop. `length` — the per-chunk cap — is the expected reason on every
 * chunk but the last, so treating it as terminal would truncate every model to
 * one chunk.
 */
function isTerminal(finishReason: string | null): boolean {
  return finishReason === null || finishReason === "stop";
}

/**
 * The text a chunk contributes to the source.
 *
 * Chunk 0 goes through the full extraction rules because the first reply may be
 * prose or fenced. Later chunks are asked for bare code, so only fence lines are
 * stripped — running `extractRenderCode` on a continuation would anchor on the
 * entry point it does not contain and drop the whole chunk.
 */
function chunkText(
  content: string,
  chunkIndex: number,
  entryPoint: string,
): string {
  if (chunkIndex === 0) {
    const extraction = extractRenderCode(content, entryPoint);
    // A first chunk with no entry point is still stored: the audience should
    // see what the model actually wrote, and a later chunk cannot repair a
    // missing opener. F14 decides what an unrenderable source costs.
    return extraction.ok ? extraction.code : stripFences(content);
  }

  return stripFences(content);
}
