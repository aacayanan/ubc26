import "server-only";

import { runBackgroundTask } from "@/lib/server/background/task";
import { logger } from "@/lib/server/logging/logger";
import { getOpenRouterClient } from "@/lib/server/integrations/openrouter/config";
import type { OpenRouterClient } from "@/lib/server/integrations/openrouter/client";
import type { JudgeVerdict } from "@/lib/server/services/evaluation/outcome";
import {
  markExecutionStatus,
  upsertExecution,
} from "@/lib/server/services/evaluation/persist";
import type { BriefRecord } from "@/lib/server/services/briefs/briefs";
import type { LLMModelRecord } from "@/lib/server/services/llm/models";
import type { StoredFrame } from "@/lib/server/services/evaluation/artifacts";
import {
  buildJudgeMessages,
  hashRubric,
  JUDGE_PROMPT_VERSION,
  JUDGE_SAMPLE_FRAMES,
  parseJudgeReply,
  sampleFrames,
} from "@/lib/server/services/llm/judge-prompt";
import { upsertJudgeVerdict } from "@/lib/server/services/pipeline/pipeline-persist";

/**
 * Ask the judge to rule on one model's frames (F31, invoked by F17).
 *
 * The judge is a `llm_models` row with `role = 'judge'` — configuration, never a
 * hard-coded ID — and it reuses the F16 client, so retries, timeouts and typed
 * failures behave exactly as they do for a competitor. Each call is recorded as
 * a `model_executions` row with `run_type = 'judge'`, `model_id` = the judge and
 * `subject_model_id` = the model being judged.
 *
 * The outcome is a `JudgeVerdict` (F15's shape), never a bare boolean:
 *
 *   * a provider failure, or a reply that is not the expected JSON, is
 *     `unavailable` — the round becomes retryable rather than settled on a guess;
 *   * a well-formed ruling is `ruled`, with the per-criterion answers kept so
 *     the results view can explain the decision.
 *
 * Frames are read from storage, so re-judging never re-generates or re-renders
 * (F31 acceptance).
 */

export interface JudgeModelInput {
  roundId: string;
  judge: LLMModelRecord;
  subjectModelId: string;
  brief: BriefRecord;
  frames: StoredFrame[];
  correlationId: string;
  /** `attempt` is the model's position in the round (1-based), not an HTTP retry. */
  attempt?: number;
  /** Test seam; defaults to the configured client. */
  client?: OpenRouterClient;
}

export interface JudgeModelResult {
  executionId: string;
  verdict: JudgeVerdict;
}

export async function judgeModelRender(
  input: JudgeModelInput,
): Promise<JudgeModelResult> {
  const { roundId, judge, subjectModelId, brief, frames, correlationId } =
    input;
  const attempt = input.attempt ?? 1;

  return runBackgroundTask(
    {
      task: "llm.judge",
      correlationId,
      context: {
        roundId,
        judgeId: judge.id,
        judgeSlug: judge.slug,
        subjectModelId,
      },
    },
    async () => {
      const client = input.client ?? getOpenRouterClient();
      const rubricSha256 = hashRubric(brief.judgeRubric);

      const { id: executionId } = await upsertExecution({
        roundId,
        modelId: judge.id,
        runType: "judge",
        attempt,
        openrouterModelId: judge.openrouterModelId,
        config: {
          params: judge.config,
          promptTemplateVersion: JUDGE_PROMPT_VERSION,
          rubricSha256,
          sampledFrames: Math.min(JUDGE_SAMPLE_FRAMES, frames.length),
          maxAttempts: client.maxAttempts,
          forfeitThreshold: client.forfeitThreshold,
        },
        status: "running",
        subjectModelId,
      });

      await markExecutionStatus(executionId, "running", {
        startedAt: new Date().toISOString(),
      });

      const sample = sampleFrames(frames, JUDGE_SAMPLE_FRAMES);

      if (sample.length === 0) {
        // No frames is not the judge's fault and not the model's verdict: the
        // gate should have stopped this, so treat it as infrastructure.
        const reason = "No frames were available to judge.";
        logger.warn("judge.unavailable", {
          correlationId,
          executionId,
          subjectModelId,
          reason,
        });
        return { executionId, verdict: { kind: "unavailable", reason } };
      }

      const outcome = await client.generate({
        model: judge.openrouterModelId,
        messages: buildJudgeMessages({ brief, frames: sample }),
        params: judge.config,
        correlationId,
      });

      const finishedAt = new Date().toISOString();

      if (!outcome.ok) {
        const reason = `The judge could not rule: ${outcome.failureKind}.`;
        await markExecutionStatus(executionId, "unavailable", {
          errorMessage: outcome.providerMessage.slice(0, 500),
          failureKind: outcome.failureKind,
          latencyMs: outcome.latencyMs,
          attemptCount: outcome.attempts,
          providerRequestId: outcome.providerRequestId,
          finishedAt,
        });
        logger.warn("judge.unavailable", {
          correlationId,
          executionId,
          subjectModelId,
          reason,
        });
        logger.warn("judge.failed", {
          correlationId,
          executionId,
          subjectModelId,
          failureKind: outcome.failureKind,
        });
        return { executionId, verdict: { kind: "unavailable", reason } };
      }

      const parsed = parseJudgeReply(outcome.content, brief.judgeRubric);

      if (!parsed.ok) {
        // A reply we cannot read is a judge outage, not a conformance ruling.
        const reason = `The judge's reply could not be read (${parsed.reason}).`;
        await markExecutionStatus(executionId, "error", {
          errorMessage: reason,
          failureKind: "malformed_response",
          latencyMs: outcome.latencyMs,
          attemptCount: outcome.attempts,
          providerRequestId: outcome.providerRequestId,
          finishedAt,
        });
        logger.warn("judge.unavailable", {
          correlationId,
          executionId,
          subjectModelId,
          reason,
        });
        logger.warn("judge.unparseable", {
          correlationId,
          executionId,
          subjectModelId,
          reason: parsed.reason,
        });
        return { executionId, verdict: { kind: "unavailable", reason } };
      }

      const ruling = parsed.ruling;
      const verdict: JudgeVerdict = {
        kind: "ruled",
        conformed: ruling.conformed,
        reason: ruling.reason,
      };

      await markExecutionStatus(executionId, "succeeded", {
        latencyMs: outcome.latencyMs,
        attemptCount: outcome.attempts,
        providerRequestId: outcome.providerRequestId,
        responseMeta: {
          requestedModel: judge.openrouterModelId,
          servedModel: outcome.servedModel,
          usage: outcome.usage,
          promptTemplateVersion: JUDGE_PROMPT_VERSION,
          sampledFrames: sample.length,
        },
        finishedAt,
      });

      await upsertJudgeVerdict({
        executionId,
        roundId,
        subjectModelId,
        verdict: ruling.conformed ? "conformed" : "not_conformed",
        reason: ruling.reason,
        criteria: ruling.criteria,
        rubricSha256,
      });

      logger.info("judge.ruled", {
        correlationId,
        executionId,
        subjectModelId,
        conformed: ruling.conformed,
      });

      return { executionId, verdict };
    },
  );
}
