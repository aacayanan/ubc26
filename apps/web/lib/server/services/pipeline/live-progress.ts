import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RenderedFrame, RoundStatus } from "@ai-showdown/shared";
import { InternalError, NotFoundError } from "@/lib/server/errors/app-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";

/**
 * Live round progress for the viewer (F17 acceptance: live progress is
 * queryable; the UI itself is F27/F19).
 *
 * The two-clocks rule decides visibility, and it is enforced here as well as in
 * RLS: nothing that could reveal a render exists before the round is past
 * `OPEN`. A round that has not locked reports only its models and state — no
 * code, no frames — so this endpoint cannot be used to peek at an outcome while
 * stakes are still open.
 *
 * The assembly is deliberately plain: the viewer polls, and every read is a
 * handful of indexed lookups rather than a join graph. Progress is exactly
 * "what each model has produced so far", which is what a polling viewer needs.
 */

export interface LiveModelProgress {
  modelId: string;
  name: string;
  ordinal: number;
  /** `pending` until the first chunk exists, then the execution's status. */
  state:
    | "pending"
    | "generating"
    | "rendering"
    | "judging"
    | "conformed"
    | "not_conformed"
    | "forfeited"
    | "unavailable";
  /** The code written so far, revealed only after the round locks. */
  code: string | null;
  /** Whether the latest preview chunk was parseable; false is "compiling…". */
  compiling: boolean;
  /** Preview frames of the partial render, oldest first. */
  previewFrames: RenderedFrame[];
  /** Full-geometry frames once the finished source has been rendered. */
  frames: RenderedFrame[];
  gatePassed: boolean | null;
  judge: {
    verdict: "conformed" | "not_conformed" | "unavailable";
    reason: string;
    criteria: Array<{
      id: string;
      question: string;
      passed: boolean;
      reason: string;
    }>;
  } | null;
  /** Viewer-safe explanation when the model forfeited at generation time. */
  failureReason: string | null;
}

export interface LiveRoundProgress {
  roundId: string;
  slug: string;
  status: RoundStatus;
  /** True once the round is past OPEN; only then is anything renderable shown. */
  revealed: boolean;
  brief: { title: string; prompt: string } | null;
  models: LiveModelProgress[];
  /** The round's recorded outcome, once F15/F18 have written one. */
  outcome: {
    kind: "settled" | "voided";
    winnerModelId: string | null;
    fanFavoriteModelId: string | null;
    reason: string;
  } | null;
}

interface ExecutionRow {
  id: string;
  model_id: string;
  run_type: string;
  status: string;
  solution_code: string | null;
  error_message: string | null;
  subject_model_id: string | null;
  attempt: number;
}

/** Round statuses at which a render may be shown (the two-clocks rule). */
const REVEALED_STATUSES: readonly RoundStatus[] = [
  "LOCKED",
  "RUNNING",
  "EVALUATING",
  "SETTLED",
  "VOIDED",
  "ARCHIVED",
  "RETRYING",
  "FAILED",
  "CANCELLED",
];

export function isRevealed(status: RoundStatus): boolean {
  return REVEALED_STATUSES.includes(status);
}

export async function getLiveRoundProgress(
  roundId: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<LiveRoundProgress> {
  const { data: roundData, error: roundError } = await supabase
    .from("rounds")
    .select("id, slug, status, challenge_id")
    .eq("id", roundId)
    .maybeSingle();

  if (roundError) {
    throw new InternalError("Failed to read the round", roundError);
  }

  if (!roundData) {
    throw new NotFoundError(`Round ${roundId} does not exist`);
  }

  const round = roundData as {
    id: string;
    slug: string;
    status: RoundStatus;
    challenge_id: string;
  };
  const revealed = isRevealed(round.status);

  const { data: modelRows, error: modelError } = await supabase
    .from("round_models")
    .select("ordinal, llm_models(id, name)")
    .eq("round_id", roundId)
    .order("ordinal", { ascending: true })
    .order("model_id", { ascending: true });

  if (modelError) {
    throw new InternalError("Failed to read the round's models", modelError);
  }

  const models = (
    (modelRows ?? []) as Array<{
      ordinal: number;
      llm_models:
        { id: string; name: string } | Array<{ id: string; name: string }>;
    }>
  ).flatMap((row) => {
    const model = Array.isArray(row.llm_models)
      ? row.llm_models[0]
      : row.llm_models;
    return model
      ? [{ modelId: model.id, name: model.name, ordinal: row.ordinal }]
      : [];
  });

  // Before the round locks, nothing about a render is readable — including the
  // brief text, which a better-scoped surface (F9) already shows while OPEN.
  if (!revealed) {
    return {
      roundId: round.id,
      slug: round.slug,
      status: round.status,
      revealed: false,
      brief: null,
      models: models.map((model) => ({
        ...model,
        state: "pending",
        code: null,
        compiling: false,
        previewFrames: [],
        frames: [],
        gatePassed: null,
        judge: null,
        failureReason: null,
      })),
      outcome: null,
    };
  }

  const { data: briefRow } = await supabase
    .from("challenges")
    .select("title, prompt")
    .eq("id", round.challenge_id)
    .maybeSingle();

  const { data: executionRows, error: execError } = await supabase
    .from("model_executions")
    .select(
      "id, model_id, run_type, status, solution_code, error_message, subject_model_id, attempt",
    )
    .eq("round_id", roundId)
    .order("attempt", { ascending: true });

  if (execError) {
    throw new InternalError("Failed to read the round's executions", execError);
  }

  const executions = (executionRows ?? []) as ExecutionRow[];
  const generationByModel = new Map<string, ExecutionRow>();
  for (const execution of executions) {
    if (execution.run_type !== "generation") continue;
    generationByModel.set(execution.model_id, execution);
  }

  const judgeRows = new Map<string, LiveModelProgress["judge"]>();

  const { data: verdictRows } = await supabase
    .from("judge_verdicts")
    .select("subject_model_id, verdict, reason, criteria")
    .eq("round_id", roundId);

  for (const row of (verdictRows ?? []) as Array<{
    subject_model_id: string;
    verdict: "conformed" | "not_conformed" | "unavailable";
    reason: string;
    criteria: unknown;
  }>) {
    judgeRows.set(row.subject_model_id, {
      verdict: row.verdict,
      reason: row.reason,
      criteria: Array.isArray(row.criteria)
        ? (row.criteria as Array<{
            id: string;
            question: string;
            passed: boolean;
            reason: string;
          }>)
        : [],
    });
  }

  const progress: LiveModelProgress[] = [];

  for (const model of models) {
    const execution = generationByModel.get(model.modelId);
    const judge = judgeRows.get(model.modelId) ?? null;

    const previews = execution
      ? await readPreviews(execution.id, supabase)
      : [];
    const artifact = execution
      ? await readArtifact(execution.id, supabase)
      : null;

    const latest = previews[previews.length - 1] ?? null;

    progress.push({
      ...model,
      state: deriveState(execution, judge),
      code: execution?.solution_code ?? null,
      // "Compiling…" means the latest partial source could not be parsed yet —
      // the code is growing and the next chunk may still close the function.
      compiling: latest !== null && !latest.parseOk,
      previewFrames: previews.flatMap((preview) => preview.frames),
      frames: artifact?.frames ?? [],
      gatePassed: artifact?.gatePassed ?? null,
      judge,
      failureReason:
        execution && execution.status !== "succeeded"
          ? execution.error_message
          : null,
    });
  }

  const { data: outcomeRow } = await supabase
    .from("round_outcomes")
    .select("kind, winner_model_id, fan_favorite_model_id, reason")
    .eq("round_id", roundId)
    .maybeSingle();

  return {
    roundId: round.id,
    slug: round.slug,
    status: round.status,
    revealed: true,
    brief: briefRow
      ? {
          title: (briefRow as { title: string }).title,
          prompt: (briefRow as { prompt: string }).prompt,
        }
      : null,
    models: progress,
    outcome: outcomeRow
      ? {
          kind: (outcomeRow as { kind: "settled" | "voided" }).kind,
          winnerModelId: (outcomeRow as { winner_model_id: string | null })
            .winner_model_id,
          fanFavoriteModelId: (
            outcomeRow as { fan_favorite_model_id: string | null }
          ).fan_favorite_model_id,
          reason: (outcomeRow as { reason: string }).reason,
        }
      : null,
  };
}

function deriveState(
  execution: ExecutionRow | undefined,
  judge: { verdict: string } | null,
): LiveModelProgress["state"] {
  if (judge) {
    return judge.verdict === "conformed"
      ? "conformed"
      : judge.verdict === "not_conformed"
        ? "not_conformed"
        : "unavailable";
  }

  if (!execution) return "pending";

  switch (execution.status) {
    case "pending":
      return "pending";
    case "running":
      return "generating";
    case "succeeded":
      // Generated; either rendering full frames or awaiting the judge.
      return "judging";
    case "unavailable":
      return "unavailable";
    case "timeout":
    case "error":
      return "forfeited";
    default:
      return "generating";
  }
}

async function readPreviews(
  executionId: string,
  supabase: SupabaseClient,
): Promise<
  Array<{
    chunkIndex: number;
    parseOk: boolean;
    rendered: boolean;
    frames: RenderedFrame[];
  }>
> {
  const { data } = await supabase
    .from("render_previews")
    .select("chunk_index, parse_ok, rendered, frames")
    .eq("execution_id", executionId)
    .order("chunk_index", { ascending: true });

  return (
    (data ?? []) as Array<{
      chunk_index: number;
      parse_ok: boolean;
      rendered: boolean;
      frames: unknown;
    }>
  ).map((row) => ({
    chunkIndex: row.chunk_index,
    parseOk: row.parse_ok,
    rendered: row.rendered,
    frames: Array.isArray(row.frames) ? (row.frames as RenderedFrame[]) : [],
  }));
}

async function readArtifact(
  executionId: string,
  supabase: SupabaseClient,
): Promise<{ gatePassed: boolean; frames: RenderedFrame[] } | null> {
  const { data } = await supabase
    .from("rendered_artifacts")
    .select("gate_passed, frames")
    .eq("execution_id", executionId)
    .maybeSingle();

  if (!data) return null;

  const row = data as { gate_passed: boolean; frames: unknown };
  return {
    gatePassed: row.gate_passed,
    frames: Array.isArray(row.frames) ? (row.frames as RenderedFrame[]) : [],
  };
}
