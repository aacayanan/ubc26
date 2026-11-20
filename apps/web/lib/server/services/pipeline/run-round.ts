import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChunkPolicy, RoundStatus } from "@ai-showdown/shared";
import { ConflictError, InternalError } from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import {
  getChunkPolicy,
  chunkParams,
} from "@/lib/server/services/evaluation/chunk-policy";
import { evaluateArtifact } from "@/lib/server/services/evaluation/artifact-run";
import { isEligibleForJudging } from "@/lib/server/services/evaluation/artifact-run";
import { renderPreview } from "@/lib/server/services/evaluation/preview-run";
import { getRenderedArtifact } from "@/lib/server/services/evaluation/artifacts";
import type { StoredFrame } from "@/lib/server/services/evaluation/artifacts";
import { upsertExecution } from "@/lib/server/services/evaluation/persist";
import { getJudgeVerdict } from "@/lib/server/services/pipeline/pipeline-persist";
import {
  loadRoundRunInputs,
  type RoundParticipant,
  type RoundRunInputs,
} from "@/lib/server/services/pipeline/round-inputs";
import { generateChunks } from "@/lib/server/services/llm/generate-chunks";
import { BettingMeter } from "@/lib/server/services/wagering/betting";
import {
  getActiveJudge,
  type LLMModelRecord,
} from "@/lib/server/services/llm/models";
import { judgeModelRender } from "@/lib/server/services/llm/judge";
import { toGenerationChallenge } from "@/lib/server/services/llm/prompt";
import type { JudgeVerdict } from "@/lib/server/services/evaluation/outcome";

/**
 * The round pipeline (F17).
 *
 * Drives one LOCKED round through, in order, for every participating model:
 *
 *   reveal the brief → chunked generation (each chunk previewed) →
 *   render the finished source and gate it (F14) → judge it (F31)
 *
 * Two invariants this module is responsible for:
 *
 *   * **It only runs from a valid locked round.** `assertRunnable` checks the
 *     status before any work; a round in SETTLED/ARCHIVED/CANCELLED is refused.
 *     RUNNING and EVALUATING are accepted so a restart can resume a round a
 *     previous process already advanced.
 *   * **Restarting is safe and cheap.** Every stage persists before the next
 *     begins, keyed so a re-run updates rather than duplicates:
 *     `generation_chunks(execution, index)` means an existing chunk is not
 *     re-generated; `rendered_artifacts(execution)` means a finished render is
 *     re-read, not re-run; `judge_verdicts(execution)` means a ruling is not
 *     re-asked for.
 *
 * It deliberately stops at "every model has a verdict" — F15's resolver and F18's
 * settlement decide the outcome. This module returns the per-model verdicts so
 * the caller can hand them straight to `resolveRoundOutcome`.
 */

/** Statuses the pipeline may start or continue from. */
const RUNNABLE_STATUSES: readonly RoundStatus[] = [
  "LOCKED",
  "RUNNING",
  "EVALUATING",
  "RETRYING",
];

export function assertRunnable(status: RoundStatus): void {
  if (!RUNNABLE_STATUSES.includes(status)) {
    throw new ConflictError(
      `The pipeline only runs a locked round; round status is ${status}`,
    );
  }
}

/**
 * What the pipeline decided for one model.
 *
 * `gate` and `judge` are F15's inputs; `forfeited` folds a generation failure in
 * so the caller does not have to know that a forfeit can come from before the
 * render stage. The reason strings are viewer-safe (F19).
 */
export interface ModelPipelineResult {
  modelId: string;
  name: string;
  ordinal: number;
  executionId: string | null;
  gate: {
    passed: boolean;
    unavailable: boolean;
    failureReason: string | null;
  };
  judge: JudgeVerdict | null;
  /** True when generation failed: the model never got a renderable source. */
  generationForfeited: boolean;
  /** Viewer-safe explanation of a generation forfeit, when there is one. */
  generationFailureReason: string | null;
}

export interface RunRoundPipelineInput {
  roundId: string;
  correlationId: string;
  /** Injectable for tests; defaults to the environment policy. */
  policy?: ChunkPolicy;
  /** Injectable for tests. */
  supabase?: SupabaseClient;
  /**
   * Skip the judge stage. Used by the demo path when no judge is seated and by
   * tests; the round then stays retryable rather than settling on a guess.
   */
  skipJudge?: boolean;
}

export interface RunRoundPipelineResult {
  roundId: string;
  slug: string;
  models: ModelPipelineResult[];
  /** True when a judge was seated and every gate-passing model was judged. */
  judged: boolean;
}

export async function runRoundPipeline(
  input: RunRoundPipelineInput,
): Promise<RunRoundPipelineResult> {
  const { roundId, correlationId } = input;
  const supabase = input.supabase ?? getServiceRoleSupabase();
  const policy = input.policy ?? getChunkPolicy();

  const inputs = await loadRoundRunInputs(roundId, supabase);
  assertRunnable(inputs.status);

  // Move the round out of LOCKED so the work is visible and so this job stops
  // re-picking it. Without this the round stays LOCKED forever, which both
  // misreports it to the viewer and makes `listRoundsForPipeline` hand the same
  // finished round back on every tick.
  if (inputs.status === "LOCKED") {
    await moveRoundTo(supabase, roundId, "RUNNING");
  }

  logger.info("pipeline.round.started", {
    correlationId,
    roundId,
    slug: inputs.slug,
    models: inputs.participants.length,
    maxChunks: policy.maxChunks,
  });

  // The judge is optional. Without one, gate-passing models get no verdict and
  // F15 keeps the round retryable — the honest outcome, not a fabricated pass.
  const judge = input.skipJudge ? null : await getActiveJudge(supabase);

  if (!judge) {
    logger.warn("pipeline.judge.absent", { correlationId, roundId });
  }

  // Generation runs for every model at once: that is the show. The audience
  // watches three models write to the same brief simultaneously, and the slow
  // part of a round is provider latency, not CPU.
  //
  // Rendering does not follow it in parallel. Each preview and each full render
  // spawns a headless Chromium with its own CPU and memory reservation, and
  // three of those at once is how a round times out on a small deploy host. So
  // the limiter below lets exactly one container run at a time: the models race,
  // the sandbox queues.
  const runContainer = createLimiter(1);

  // SOL rounds: live betting is open while the models generate. The meter
  // closes it — before the triggering output is revealed — when the first
  // model reaches the cutoff share of its token budget, or finishes, or fails.
  // For points rounds it is inert.
  const meter = await BettingMeter.forRound(
    roundId,
    inputs.participants.map((participant) => participant.id),
    supabase,
  );

  // A resumed run cannot trust an in-memory meter that restarted at zero, so a
  // round that was already RUNNING closes betting before generating anything.
  if (inputs.status !== "LOCKED" && meter.active) {
    await meter.close("admin");
  }

  const stallTimer = setInterval(() => {
    meter.checkStall().catch((error) => {
      logger.warn("betting.stall_check.failed", {
        correlationId,
        roundId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
  }, 5_000);

  let generated: GeneratedModel[];
  try {
    generated = await Promise.all(
      inputs.participants.map((participant) =>
        generateOneModel({
          inputs,
          participant,
          policy,
          correlationId,
          runContainer,
          meter,
        }),
      ),
    );
  } catch (error) {
    // Never leave betting open on a broken run.
    await meter.close("model_failed").catch(() => undefined);
    throw error;
  } finally {
    clearInterval(stallTimer);
  }

  // Every model has stopped generating. Whatever closed betting, it is closed
  // before a single final render, gate result or verdict exists.
  await meter.close("all_models_stopped");

  // Render and judge one model at a time, in lineup order, so the sandbox work
  // is bounded and the finished renders appear in a predictable sequence.
  const results: ModelPipelineResult[] = [];
  for (const model of generated) {
    results.push(
      await finishOneModel({ inputs, generated: model, judge, correlationId }),
    );
  }

  // "Judged" means every model that was *eligible* to be judged got a ruling.
  // A forfeit or an infrastructure outage is never eligible, so it does not make
  // the round unjudged — but a gate-passing model left without a verdict does.
  const judged =
    judge !== null &&
    results.every(
      (result) =>
        !result.gate.passed || result.gate.unavailable || result.judge !== null,
    );

  // EVALUATING means "every verdict this round can have is in; settlement is
  // F15/F18's job". Only claim it when that is true — a round left RUNNING is
  // the honest signal that it still needs another pass (a missing judge, or a
  // provider outage that made a ruling unavailable).
  if (judged) {
    await moveRoundTo(supabase, roundId, "EVALUATING");
  }

  logger.info("pipeline.round.finished", {
    correlationId,
    roundId,
    slug: inputs.slug,
    judged,
    conformed: results.filter(
      (r) => r.judge?.kind === "ruled" && r.judge.conformed,
    ).length,
    forfeited: results.filter((r) => r.generationForfeited).length,
  });

  return { roundId, slug: inputs.slug, models: results, judged };
}

interface RunOneModelParams {
  inputs: RoundRunInputs;
  participant: RoundParticipant;
  policy: ChunkPolicy;
  correlationId: string;
  /** Serializes sandbox work so only one Chromium container runs at a time. */
  runContainer: <T>(task: () => Promise<T>) => Promise<T>;
  /** SOL rounds' betting cutoff; inert for points rounds. */
  meter: BettingMeter;
}

/** What generation produced for one model, before render and judge. */
interface GeneratedModel {
  participant: RoundParticipant;
  executionId: string;
  generation: Awaited<ReturnType<typeof generateChunks>>;
}

/**
 * Run one model's chunked generation, previewing each chunk as it lands.
 *
 * Called concurrently for every participant. The only work inside that is
 * serialized is the preview render, via `runContainer` — the provider call
 * itself is what should overlap.
 */
async function generateOneModel(
  params: RunOneModelParams,
): Promise<GeneratedModel> {
  const { inputs, participant, policy, correlationId, runContainer, meter } =
    params;

  const challenge = toGenerationChallenge(inputs.brief);

  // The execution row is created here, before generation starts, so the chunk
  // preview callback has a real id to attach to. `upsertExecution`'s composite
  // key means a resume reuses the same row rather than creating a second one.
  const { id: executionId } = await upsertExecution({
    roundId: inputs.roundId,
    modelId: participant.id,
    runType: "generation",
    attempt: 1,
    openrouterModelId: participant.openrouterModelId,
    config: {
      chunkPolicy: policy,
      params: chunkParams(participant.config, policy),
    },
    status: "pending",
  });

  // Previews are published as each chunk lands. The callback is best-effort:
  // a preview failing must never stop generation, because the preview is the
  // show and a render error is not the model's disqualification.
  const generation = await generateChunks({
    roundId: inputs.roundId,
    executionId,
    model: participant,
    challenge,
    policy,
    correlationId,
    beforeReveal: (event) =>
      meter.beforeReveal({ ...event, modelId: participant.id }),
    onChunk: async (chunk, fullSource) => {
      try {
        await runContainer(() =>
          renderPreview({
            executionId,
            chunkIndex: chunk.chunkIndex,
            source: fullSource,
            brief: inputs.brief,
            correlationId,
          }),
        );
      } catch (error) {
        logger.warn("pipeline.preview.failed", {
          correlationId,
          modelId: participant.id,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    },
  });

  return { participant, executionId, generation };
}

/** Render the finished source, gate it (F14) and judge it (F31). */
async function finishOneModel(params: {
  inputs: RoundRunInputs;
  generated: GeneratedModel;
  judge: LLMModelRecord | null;
  correlationId: string;
}): Promise<ModelPipelineResult> {
  const { inputs, generated, judge, correlationId } = params;
  const { participant, generation } = generated;

  if (generation.forfeited || generation.code === null) {
    return {
      modelId: participant.id,
      name: participant.name,
      ordinal: participant.ordinal,
      executionId: generation.executionId,
      gate: {
        passed: false,
        // A generation forfeit is the model's own failure, not infrastructure:
        // it fails the gate rather than making the round retryable.
        unavailable: false,
        failureReason:
          generation.failureReason ??
          "The model did not produce a renderable source.",
      },
      judge: null,
      generationForfeited: true,
      generationFailureReason:
        generation.failureReason ??
        "The model's generation failed before it produced a renderable source.",
    };
  }

  // Warm the browser/preview path already happened per chunk. Now the finished
  // source is rendered at full geometry and gated (F14). On a resume, a stored
  // artifact with frames is re-read rather than re-rendered — the same code in
  // the same pinned image yields the same frames, so re-running it would only
  // re-spend a container. An artifact recording an outage, or one with no
  // frames, is rendered again.
  const existingArtifact = await getRenderedArtifact(generation.executionId);

  const reusable =
    existingArtifact &&
    !existingArtifact.unavailable &&
    existingArtifact.frames.length > 0
      ? existingArtifact
      : null;

  const artifact = reusable
    ? {
        artifactId: reusable.executionId,
        gatePassed: reusable.gatePassed,
        gateFailureReason: reusable.gateFailureReason,
        checks: reusable.checks,
        eligibleForJudging: isEligibleForJudging(reusable.gatePassed),
        framesRendered: reusable.frames.length,
        framesStored: reusable.frames.length,
        framesTruncated: reusable.framesTruncated,
        unavailable: false,
        frames: reusable.frames,
      }
    : await evaluateArtifact({
        executionId: generation.executionId,
        source: generation.code,
        brief: inputs.brief,
        correlationId,
      });

  const gate = {
    passed: artifact.gatePassed,
    unavailable: artifact.unavailable,
    failureReason: artifact.gateFailureReason,
  };

  if (!isEligibleForJudging(artifact.gatePassed) || artifact.unavailable) {
    // A failed gate is never judged (non-negotiable #9); an unavailable render
    // is F15's concern and is not a conformance question.
    return {
      modelId: participant.id,
      name: participant.name,
      ordinal: participant.ordinal,
      executionId: generation.executionId,
      gate,
      judge: null,
      generationForfeited: false,
      generationFailureReason: null,
    };
  }

  if (!judge) {
    return {
      modelId: participant.id,
      name: participant.name,
      ordinal: participant.ordinal,
      executionId: generation.executionId,
      gate,
      judge: null,
      generationForfeited: false,
      generationFailureReason: null,
    };
  }

  const judgeVerdict = await judgeOne({
    roundId: inputs.roundId,
    judge,
    subjectModelId: participant.id,
    subjectAttempt: participant.ordinal,
    brief: inputs.brief,
    frames: artifact.frames,
    correlationId,
  });

  return {
    modelId: participant.id,
    name: participant.name,
    ordinal: participant.ordinal,
    executionId: generation.executionId,
    gate,
    judge: judgeVerdict,
    generationForfeited: false,
    generationFailureReason: null,
  };
}

/**
 * Judge one model's stored frames.
 *
 * Re-judging stored frames is cheap because the frames are already in Postgres
 * (F31 acceptance): a restart re-reads what was rendered and re-asks the judge,
 * rather than re-generating or re-rendering. The judge execution row is keyed by
 * the subject's ordinal, so a repeated call updates that row instead of stacking.
 */
async function judgeOne(params: {
  roundId: string;
  judge: LLMModelRecord;
  subjectModelId: string;
  subjectAttempt: number;
  brief: RoundRunInputs["brief"];
  frames: StoredFrame[];
  correlationId: string;
}): Promise<JudgeVerdict | null> {
  const {
    roundId,
    judge,
    subjectModelId,
    subjectAttempt,
    brief,
    frames,
    correlationId,
  } = params;

  // Resume: a stored ruling is reused rather than re-asked for. Frames are
  // already in Postgres, so this is also the cheap path for a restart.
  const existing = await getJudgeVerdict(roundId, subjectModelId);
  if (existing) {
    return {
      kind: "ruled",
      conformed: existing.verdict === "conformed",
      reason: existing.reason,
    };
  }

  if (frames.length === 0) {
    // Should be impossible after a passing gate, but never guess: report
    // unavailable so the round stays retryable.
    return {
      kind: "unavailable",
      reason: "The render was recorded without frames to judge.",
    };
  }

  const result = await judgeModelRender({
    roundId,
    judge,
    subjectModelId,
    brief,
    frames,
    correlationId,
    attempt: subjectAttempt,
  });

  return result.verdict;
}

/**
 * Move a round to a lifecycle status.
 *
 * `transition_round` owns the legal-transition matrix and treats a repeat of the
 * current status as a successful no-op, so a resume that finds the round already
 * where it wanted to put it is not an error. Failures here are fatal: a round we
 * cannot move is a round the next tick will pick up again, and silently
 * continuing would produce executions the lifecycle does not know about.
 */
async function moveRoundTo(
  supabase: SupabaseClient,
  roundId: string,
  target: RoundStatus,
): Promise<void> {
  const { error } = await supabase.rpc("transition_round", {
    p_round_id: roundId,
    p_to_status: target,
    p_reason: `pipeline: ${target.toLowerCase()}`,
  });

  if (error) {
    throw new InternalError(`Failed to move the round to ${target}`, error);
  }
}

/**
 * A tiny counting semaphore.
 *
 * Used to cap concurrent sandbox containers. It is deliberately not a general
 * purpose pool: tasks queue in submission order and each one runs to completion,
 * which is all the preview path needs.
 */
function createLimiter(
  concurrency: number,
): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }

    active += 1;

    try {
      return await task();
    } finally {
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    }
  };
}

/**
 * Rounds the pipeline may pick up now.
 *
 * RUNNABLE but not OPEN: LOCKED is the entry point, RUNNING/EVALUATING/RETRYING
 * are rounds a crashed process left mid-flight. Re-listing them is what makes
 * the internal job self-healing — it resumes whatever is unfinished instead of
 * depending on an in-memory queue.
 */
export async function listRoundsForPipeline(
  options: { limit?: number; supabase?: SupabaseClient } = {},
): Promise<Array<{ id: string; slug: string; status: RoundStatus }>> {
  const supabase = options.supabase ?? getServiceRoleSupabase();
  const limit = options.limit ?? 20;

  const { data, error } = await supabase
    .from("rounds")
    .select("id, slug, status")
    .in("status", RUNNABLE_STATUSES as string[])
    .order("locked_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(limit);

  if (error) {
    throw new InternalError("Failed to list rounds for the pipeline", error);
  }

  return (data ?? []) as Array<{
    id: string;
    slug: string;
    status: RoundStatus;
  }>;
}
