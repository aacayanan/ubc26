import "server-only";

import type { ExecutionStatus, LLMFailureKind } from "@ai-showdown/shared";
import { runBackgroundTask } from "@/lib/server/background/task";
import { logger } from "@/lib/server/logging/logger";
import { getOpenRouterClient } from "@/lib/server/integrations/openrouter/config";
import type {
  GenerationFailure,
  GenerationOutcome,
  OpenRouterClient,
} from "@/lib/server/integrations/openrouter/client";
import {
  markExecutionStatus,
  upsertExecution,
} from "@/lib/server/services/evaluation/persist";
import {
  buildGenerationMessages,
  extractRenderCode,
  hashMessages,
  PROMPT_TEMPLATE_VERSION,
  type GenerationChallenge,
} from "@/lib/server/services/llm/prompt";
import type { LLMModelRecord } from "@/lib/server/services/llm/models";

/**
 * Ask one model for a solution and record the attempt (F16).
 *
 * Mirrors the F13 sandbox runner: a `runBackgroundTask` boundary that writes the
 * `model_executions` row before the call and its final state after. The row is
 * keyed by F17's `(round_id, model_id, run_type, attempt)`; the HTTP retries
 * inside the client ride on one row and are reported as `attempt_count`.
 *
 * A model forfeits the round when its call exhausted its retries or failed in a
 * way no retry can fix (bad key, no credits, unknown model, unusable output).
 * The verdict is recorded here; deciding what a forfeit costs belongs to F15/F18.
 */

export interface GenerateModelSolutionInput {
  roundId: string;
  model: LLMModelRecord;
  challenge: GenerationChallenge;
  correlationId: string;
  /** F17 orchestration attempt; the client's retries do not advance it. */
  attempt?: number;
  /** Test seam; defaults to the configured client. */
  client?: OpenRouterClient;
}

export interface GenerateModelSolutionResult {
  executionId: string;
  status: ExecutionStatus;
  forfeited: boolean;
  outcome: GenerationOutcome;
  code: string | null;
}

// Status mapping. `unavailable` is reserved for "the provider could not serve
// this model at all" — auth, credits and unknown models are infrastructure
// problems, not the model performing badly.
const STATUS_BY_FAILURE: Record<LLMFailureKind, ExecutionStatus> = {
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

export async function generateModelSolution(
  input: GenerateModelSolutionInput,
): Promise<GenerateModelSolutionResult> {
  const { roundId, model, challenge, correlationId } = input;
  const attempt = input.attempt ?? 1;

  return runBackgroundTask(
    {
      task: "llm.generation",
      correlationId,
      context: { roundId, modelId: model.id, modelSlug: model.slug, attempt },
    },
    async () => {
      const client = input.client ?? getOpenRouterClient();
      const messages = buildGenerationMessages(challenge);
      const promptHash = hashMessages(messages);
      const startedAt = new Date().toISOString();

      // The config snapshot is the reproduction record: what params went out,
      // which prompt template, and a hash of the exact text.
      const { id: executionId } = await upsertExecution({
        roundId,
        modelId: model.id,
        runType: "generation",
        attempt,
        openrouterModelId: model.openrouterModelId,
        config: {
          params: model.config,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
          promptSha256: promptHash,
          maxAttempts: client.maxAttempts,
          forfeitThreshold: client.forfeitThreshold,
        },
        status: "running",
      });

      await markExecutionStatus(executionId, "running", { startedAt });

      const outcome = await client.generate({
        model: model.openrouterModelId,
        messages,
        params: model.config,
        correlationId,
      });

      const finishedAt = new Date().toISOString();
      const responseMeta = {
        requestedModel: model.openrouterModelId,
        servedModel: outcome.servedModel,
        finishReason: outcome.ok ? outcome.finishReason : null,
        usage: outcome.ok ? outcome.usage : null,
        attempts: outcome.attemptsDetail,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      };

      if (!outcome.ok) {
        return recordFailure({
          executionId,
          outcome,
          correlationId,
          finishedAt,
          responseMeta,
          forfeitThreshold: client.forfeitThreshold,
        });
      }

      const extraction = extractRenderCode(
        outcome.content,
        challenge.entryPoint,
      );

      if (!extraction.ok) {
        // The call succeeded but the answer is unusable — that is a model
        // failure, not an infrastructure one.
        logger.warn("llm.generation.unusable_output", {
          correlationId,
          modelId: model.id,
          reason: extraction.reason,
        });

        await markExecutionStatus(executionId, "error", {
          errorMessage: `Model returned unusable output (${extraction.reason})`,
          failureKind: "malformed_response",
          latencyMs: outcome.latencyMs,
          attemptCount: outcome.attempts,
          providerRequestId: outcome.providerRequestId,
          responseMeta: {
            ...responseMeta,
            extraction: extraction.reason,
          },
          finishedAt,
        });

        return {
          executionId,
          status: "error" as const,
          forfeited: outcome.attempts >= client.forfeitThreshold,
          outcome,
          code: null,
        };
      }

      await markExecutionStatus(executionId, "succeeded", {
        solutionCode: extraction.code,
        latencyMs: outcome.latencyMs,
        attemptCount: outcome.attempts,
        providerRequestId: outcome.providerRequestId,
        responseMeta: {
          ...responseMeta,
          extraction: "ok",
        },
        finishedAt,
      });

      logger.info("llm.generation.succeeded", {
        correlationId,
        modelId: model.id,
        latencyMs: outcome.latencyMs,
        attempts: outcome.attempts,
        codeLength: extraction.code.length,
      });

      return {
        executionId,
        status: "succeeded" as const,
        forfeited: false,
        outcome,
        code: extraction.code,
      };
    },
  );
}

async function recordFailure(params: {
  executionId: string;
  outcome: GenerationFailure;
  correlationId: string;
  finishedAt: string;
  responseMeta: Record<string, unknown>;
  forfeitThreshold: number;
}): Promise<GenerateModelSolutionResult> {
  const {
    executionId,
    outcome,
    correlationId,
    finishedAt,
    responseMeta,
    forfeitThreshold,
  } = params;

  const status = STATUS_BY_FAILURE[outcome.failureKind];
  // Retriable classes forfeit only once the attempts are spent; terminal ones
  // (bad key, no credits) forfeit immediately — retrying would change nothing.
  const forfeited = outcome.exhausted
    ? outcome.attempts >= forfeitThreshold
    : true;

  await markExecutionStatus(executionId, status, {
    errorMessage: outcome.providerMessage.slice(0, 500),
    failureKind: outcome.failureKind,
    latencyMs: outcome.latencyMs,
    attemptCount: outcome.attempts,
    providerRequestId: outcome.providerRequestId,
    responseMeta: {
      ...responseMeta,
      exhausted: outcome.exhausted,
      statusCode: outcome.status,
    },
    finishedAt,
  });

  if (forfeited) {
    logger.warn("llm.generation.forfeited", {
      correlationId,
      executionId,
      failureKind: outcome.failureKind,
      attempts: outcome.attempts,
      statusCode: outcome.status,
    });
  }

  return {
    executionId,
    status,
    forfeited,
    outcome,
    code: null,
  };
}
