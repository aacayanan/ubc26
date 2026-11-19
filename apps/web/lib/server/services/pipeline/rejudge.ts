import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ConflictError,
  InternalError,
  NotFoundError,
} from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getRenderedArtifact } from "@/lib/server/services/evaluation/artifacts";
import type { JudgeVerdict } from "@/lib/server/services/evaluation/outcome";
import { isEligibleForJudging } from "@/lib/server/services/evaluation/artifact-run";
import type { BriefRecord } from "@/lib/server/services/briefs/briefs";
import {
  getActiveJudge,
  type LLMModelRecord,
} from "@/lib/server/services/llm/models";
import { judgeModelRender } from "@/lib/server/services/llm/judge";
import { assertRunnable } from "@/lib/server/services/pipeline/run-round";
import {
  loadRoundRunInputs,
  type RoundParticipant,
} from "@/lib/server/services/pipeline/round-inputs";

/**
 * Operator re-judge (F31 acceptance: "judging can be re-run on stored frames
 * without re-generating code").
 *
 * The F17 pipeline already re-uses a stored artifact rather than re-rendering,
 * but it also *stops* at an existing verdict — a resume does not re-ask the
 * judge, because a crash mid-round must not re-spend judge calls. That leaves no
 * way to re-run judging after the fact: a malformed reply, a judge outage, or a
 * rubric fix all need a second look at the same frames.
 *
 * This module is that path, and only that path. It reads the stored artifact for
 * each competitor, skips anything that was never judgeable, and asks the seated
 * judge again. Nothing here generates or renders: the frames come from Postgres,
 * which is what makes re-judging cheap and reproducible.
 *
 * Two rules it keeps:
 *
 *   * **It obeys the same fences as the pipeline.** A round that has not locked
 *     has no render to judge, and a finalized round's verdict is not rewritten
 *     here (`assertRunnable`, the same check the pipeline uses). A failed
 *     deterministic gate is never sent to the judge (non-negotiable #9).
 *   * **It never invents a verdict.** A judge outage during a re-judge is a
 *     typed `unavailable`, exactly as in the first pass; the caller decides
 *     whether to retry. A re-judge that cannot run at all throws rather than
 *     reporting partial success.
 *
 * Re-judging replaces the existing ruling rather than stacking one: the judge
 * execution is keyed by the subject's ordinal and `judge_verdicts` is unique on
 * `(round_id, subject_model_id)`, so a second pass updates those rows.
 */

export interface RejudgeRoundInput {
  roundId: string;
  correlationId: string;
  /**
   * Restrict the re-judge to one competitor. Omitted means every eligible model
   * in the round — the shape an operator uses after fixing a rubric.
   */
  subjectModelId?: string;
  /** Injectable for tests. */
  supabase?: SupabaseClient;
}

/** What the re-judge did for one model. */
export interface RejudgedModel {
  modelId: string;
  name: string;
  ordinal: number;
  /**
   * `judged` means the judge was asked again and `verdict` says what it ruled.
   * `skipped` means the model was not eligible to judge, and `reason` says why —
   * never a silent omission.
   */
  status: "judged" | "skipped";
  /** Present when `status = "judged"`; `unavailable` is a typed non-verdict. */
  verdict: JudgeVerdict | null;
  /** Viewer-safe reason for a skip, or the judge's summary reason. */
  reason: string | null;
}

export interface RejudgeRoundResult {
  roundId: string;
  slug: string;
  judgeModelId: string;
  models: RejudgedModel[];
  /** True when every model in the round was eligible and got a fresh ruling. */
  allJudged: boolean;
}

export async function rejudgeRound(
  input: RejudgeRoundInput,
): Promise<RejudgeRoundResult> {
  const { roundId, correlationId, subjectModelId } = input;
  const supabase = input.supabase ?? getServiceRoleSupabase();

  const round = await loadRoundRunInputs(roundId, supabase);

  // The same fence the pipeline uses: nothing is judged before the betting
  // window closes, and a finalized round is not re-ruled. `assertRunnable`
  // throws `ConflictError`, which the route surfaces as a 409.
  assertRunnable(round.status);

  const judge = await getActiveJudge(supabase);
  if (!judge) {
    throw new ConflictError(
      "No judge is seated, so frames cannot be re-judged. Activate a role = 'judge' llm_models row first.",
    );
  }

  const participants = selectSubjects(round.participants, subjectModelId);

  logger.info("judge.rejudge.started", {
    correlationId,
    roundId,
    judgeSlug: judge.slug,
    subjects: participants.map((participant) => participant.id),
  });

  const generationExecutions = await loadGenerationExecutions(
    roundId,
    supabase,
  );

  const models: RejudgedModel[] = [];

  // Sequenced, not parallel: each judge call is a vision request, and the
  // pipeline already treats the judge as one-at-a-time work.
  for (const participant of participants) {
    models.push(
      await rejudgeOne({
        roundId,
        judge,
        participant,
        brief: round.brief,
        generationExecutionId: generationExecutions.get(participant.id) ?? null,
        correlationId,
      }),
    );
  }

  // "All judged" requires every competitor to have been eligible, not merely
  // every requested subject: a single-subject re-judge is never "all".
  const allJudged =
    subjectModelId === undefined &&
    models.length === round.participants.length &&
    models.every((model) => model.status === "judged");

  logger.info("judge.rejudge.finished", {
    correlationId,
    roundId,
    judged: models.filter((model) => model.status === "judged").length,
    skipped: models.filter((model) => model.status === "skipped").length,
    allJudged,
  });

  return {
    roundId,
    slug: round.slug,
    judgeModelId: judge.id,
    models,
    allJudged,
  };
}

function selectSubjects(
  participants: RoundParticipant[],
  subjectModelId: string | undefined,
): RoundParticipant[] {
  if (subjectModelId === undefined) return participants;

  const match = participants.find(
    (participant) => participant.id === subjectModelId,
  );

  if (!match) {
    throw new NotFoundError(
      `Model ${subjectModelId} does not compete in this round`,
    );
  }

  return [match];
}

/** Read the stored artifact and re-ask the judge, or explain why not. */
async function rejudgeOne(params: {
  roundId: string;
  judge: LLMModelRecord;
  participant: RoundParticipant;
  brief: BriefRecord;
  generationExecutionId: string | null;
  correlationId: string;
}): Promise<RejudgedModel> {
  const {
    roundId,
    judge,
    participant,
    brief,
    generationExecutionId,
    correlationId,
  } = params;

  const skip = (reason: string): RejudgedModel => ({
    modelId: participant.id,
    name: participant.name,
    ordinal: participant.ordinal,
    status: "skipped",
    verdict: null,
    reason,
  });

  if (generationExecutionId === null) {
    // The model never produced code to render, so there is nothing to judge.
    // This is a forfeit the first pass already recorded; a re-judge does not
    // change it.
    return skip(
      "This model did not generate a render, so there are no frames to judge.",
    );
  }

  const artifact = await getRenderedArtifact(generationExecutionId);

  if (artifact === null) {
    return skip("This model has no stored render to judge.");
  }

  if (artifact.unavailable) {
    return skip(
      "The render could not be captured, so there are no frames to judge.",
    );
  }

  if (!isEligibleForJudging(artifact.gatePassed)) {
    // Non-negotiable #9: a failed deterministic gate is never judged.
    return skip(
      artifact.gateFailureReason ??
        "The render did not pass the deterministic checks, so it is never judged.",
    );
  }

  if (artifact.frames.length === 0) {
    return skip("The stored render has no frames to judge.");
  }

  const result = await judgeModelRender({
    roundId,
    judge,
    subjectModelId: participant.id,
    brief,
    frames: artifact.frames,
    correlationId,
    attempt: participant.ordinal,
  });

  return {
    modelId: participant.id,
    name: participant.name,
    ordinal: participant.ordinal,
    status: "judged",
    verdict: result.verdict,
    reason: result.verdict.reason,
  };
}

/**
 * Map each competitor to its generation execution, if it has one.
 *
 * A `generation` execution is unique per (round, model, run_type, attempt), and
 * attempt 1 is the pipeline's only generation run, so the first row wins. A
 * missing entry means the model never got far enough to render.
 */
async function loadGenerationExecutions(
  roundId: string,
  supabase: SupabaseClient,
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("model_executions")
    .select("id, model_id, run_type, attempt")
    .eq("round_id", roundId)
    .eq("run_type", "generation")
    .order("attempt", { ascending: true });

  if (error) {
    throw new InternalError(
      "Failed to read the round's generation executions",
      error,
    );
  }

  const byModel = new Map<string, string>();
  for (const row of (data ?? []) as Array<{
    id: string;
    model_id: string;
  }>) {
    if (!byModel.has(row.model_id)) byModel.set(row.model_id, row.id);
  }

  return byModel;
}

/**
 * The verdicts a re-judge produced, in the shape F15's resolver consumes.
 *
 * Re-judging changes `judge_verdicts`; it deliberately does not re-resolve the
 * round or settle stakes. Surfacing this helper keeps that boundary explicit:
 * an operator re-judges, then a separate settlement step consumes the result.
 */
export function toJudgeVerdicts(
  models: readonly RejudgedModel[],
): Array<{ modelId: string; verdict: JudgeVerdict }> {
  return models.flatMap((model) =>
    model.verdict === null
      ? []
      : [{ modelId: model.modelId, verdict: model.verdict }],
  );
}
