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
  assembleFinalSource,
  assessPartialSource,
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
 * The loop runs every one of `policy.maxChunks` slots for every model, even when
 * a model says it is finished partway through. That is not cosmetic: the round's
 * live framing ("2 of 4 chunks") and the SOL betting cutoff both key off chunk
 * position, and a model that stopped at chunk 1 of 4 while its rivals wrote 4
 * used to close betting in the middle of the race. A model whose code already
 * parses gets an *extension* instruction for its remaining slots (see
 * `extensionInstruction` in prompt.ts) — it keeps building the same scene rather
 * than being asked for code it already wrote.
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
  /**
   * SOL rounds: awaited after a chunk returns from the provider and BEFORE it
   * is stored or previewed, and before a finished/failed status is written —
   * so the betting cutoff commits before anything past it becomes visible.
   * A throw stops generation rather than revealing output with betting open.
   */
  beforeReveal?: (event: {
    kind: "chunk" | "finished" | "failed";
    outputTokens?: number | null;
    chars?: number;
    terminal?: boolean;
  }) => Promise<void>;
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
          continue;
        }

        const codeSoFar = joinChunks(chunks);
        // A model that already wrote a complete renderer has nothing to
        // continue; its remaining chunks extend the scene instead. This is what
        // keeps every model's chunk count identical to the round's schedule.
        const completeSoFar =
          chunks.length > 0 &&
          assessPartialSource(codeSoFar, challenge.entryPoint).parsable;

        const messages = buildChunkMessages({
          challenge,
          codeSoFar,
          chunkIndex: index,
          isFinalChunk: index === policy.maxChunks - 1,
          completeSoFar,
        });

        const outcome = await client.generate({
          model: model.openrouterModelId,
          messages,
          params: chunkParams(model.config, policy),
          correlationId,
        });

        if (!outcome.ok) {
          await input.beforeReveal?.({ kind: "failed" });
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

        // `terminal` is the "this chunk completes the model's answer" signal the
        // betting meter turns into a close. It is true only on the round's last
        // slot: a model that says "stop" at chunk 1 of 4 is finished with *that
        // reply*, not with the round, and closing betting on it would end the
        // window while its rivals are still writing. Every model reaches the
        // last slot, so every model closes at the same point in the race.
        await input.beforeReveal?.({
          kind: "chunk",
          outputTokens: outcome.usage?.outputUnits ?? null,
          chars: outcome.content.length,
          terminal: index === policy.maxChunks - 1,
        });

        const source = chunkText(outcome.content, index, {
          entryPoint: challenge.entryPoint,
          completeSoFar,
        });
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

        // `stop` means the model finished *this reply*; `length` means it hit
        // the cap. Neither ends the run while slots remain — the loop always
        // fills `maxChunks`, so a model that stops early keeps extending the
        // scene instead of finishing the round a chunk ahead of its rivals.
      }

      // A cut-off extension slot must not cost a model the renderer it had
      // already finished; `assembleFinalSource` drops back to the last prefix
      // the model itself declared complete. See its doc comment.
      const assembled = assembleFinalSource(chunks, challenge.entryPoint);
      const code = assembled.source;

      if (assembled.truncatedToChunk !== null) {
        logger.warn("llm.chunks.truncated_extension", {
          correlationId,
          executionId,
          keptThroughChunk: assembled.truncatedToChunk,
        });
      }

      await input.beforeReveal?.({ kind: "finished" });

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

/** The first fenced block, with or without a language tag, across newlines. */
const FENCED_BLOCK = /```(?:javascript|js|html)?[ \t]*\r?\n([\s\S]*?)```/;

/**
 * The text a chunk contributes to the source.
 *
 * Chunk 0 goes through the full extraction rules because the first reply may be
 * prose or fenced. Continuations are asked for bare code, so only fence lines
 * are stripped — running `extractRenderCode` on a continuation would anchor on
 * the entry point it does not contain and drop the whole chunk.
 *
 * Extensions are the exception: they are told to reply with a function, and a
 * fenced reply is likely. `stripFences` removes fence *lines*, which on a
 * `\`\`\`javascript` reply would leave the bare word `javascript` in the source
 * and break the render. A fenced block is therefore unwrapped properly.
 */
function chunkText(
  content: string,
  chunkIndex: number,
  options: { entryPoint: string; completeSoFar: boolean },
): string {
  if (chunkIndex === 0) {
    const extraction = extractRenderCode(content, options.entryPoint);
    // A first chunk with no entry point is still stored: the audience should
    // see what the model actually wrote, and a later chunk cannot repair a
    // missing opener. F14 decides what an unrenderable source costs.
    return extraction.ok ? extraction.code : stripFences(content);
  }

  if (options.completeSoFar) {
    const fenced = FENCED_BLOCK.exec(content);
    if (fenced) return fenced[1].trim();
  }

  return stripFences(content);
}
