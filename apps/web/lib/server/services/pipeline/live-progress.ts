import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ChunkPolicy,
  ExecutionStatus,
  LiveModelProgress,
  LivePreview,
  LiveRoundProgress,
  RenderedFrame,
  RoundStatus,
} from "@ai-showdown/shared";
import { InternalError, NotFoundError } from "@/lib/server/errors/app-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { joinChunks } from "@/lib/server/services/evaluation/source-assembly";
import {
  deriveFailure,
  deriveModelState,
} from "@/lib/server/services/pipeline/live-model-state";
import { listChunks } from "@/lib/server/services/pipeline/pipeline-persist";

/**
 * Live round progress for the viewer (F17 backend, F27 surface).
 *
 * The two-clocks rule decides visibility, and it is enforced here as well as in
 * RLS: nothing that could reveal a render exists before the round is past
 * `OPEN`. A round that has not locked reports only its models and state — no
 * code, no frames — so this endpoint cannot be used to peek at an outcome while
 * stakes are still open.
 *
 * The payload is shaped for *polling*. A viewer hits this every couple of
 * seconds, so it carries one frame per model rather than the whole artifact and
 * one preview per chunk rather than every frame ever drawn. The full frame set
 * belongs to the results API, which is read once.
 *
 * State derivation and failure copy live in `live-model-state.ts`; this module
 * is the I/O around it.
 */

export type {
  LiveModelProgress,
  LivePreview,
  LiveRoundProgress,
} from "@ai-showdown/shared";

interface ExecutionRow {
  id: string;
  model_id: string;
  run_type: string;
  status: ExecutionStatus;
  solution_code: string | null;
  error_message: string | null;
  failure_kind: string | null;
  subject_model_id: string | null;
  attempt: number;
  config: unknown;
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

/** Round-level explanations while a round is being retried or has failed. */
const RETRY_MESSAGES: Partial<Record<RoundStatus, string>> = {
  RETRYING:
    "A render or judge could not be reached, so this round is being retried rather than settled on a guess.",
  FAILED:
    "This round could not be completed. Its stakes are void and every point returns.",
};

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
      replay: null,
      models: models.map((model) => emptyProgress(model)),
      retry: null,
      outcome: null,
    };
  }

  const { data: briefRow } = await supabase
    .from("challenges")
    .select(
      "title, prompt, entry_point, target_duration_ms, frame_count, frame_width, frame_height",
    )
    .eq("id", round.challenge_id)
    .maybeSingle();

  const brief = briefRow as {
    title: string;
    prompt: string;
    entry_point: string | null;
    target_duration_ms: number | null;
    frame_count: number | null;
    frame_width: number | null;
    frame_height: number | null;
  } | null;

  const { data: executionRows, error: execError } = await supabase
    .from("model_executions")
    .select(
      "id, model_id, run_type, status, solution_code, error_message, failure_kind, subject_model_id, attempt, config",
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

  const judgeRows = new Map<string, NonNullable<LiveModelProgress["judge"]>>();

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
      // Stored criteria carry their rubric weight (F31); older rows without one
      // normalise to 0 rather than being dropped from a public response.
      criteria: Array.isArray(row.criteria)
        ? (row.criteria as Array<Record<string, unknown>>).map((entry) => ({
            id: typeof entry.id === "string" ? entry.id : "",
            question: typeof entry.question === "string" ? entry.question : "",
            weight: typeof entry.weight === "number" ? entry.weight : 0,
            passed: entry.passed === true,
            reason: typeof entry.reason === "string" ? entry.reason : "",
          }))
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

    // The code shown is the source *written so far*, assembled from the chunks
    // that have landed. `solution_code` is only written when generation
    // finishes, so reading it alone left the pane empty for the entire stream.
    const chunks = execution ? await readChunkSource(execution, supabase) : [];
    const code =
      chunks.length > 0
        ? joinChunks(chunks)
        : (execution?.solution_code ?? null);

    const latest = previews[previews.length - 1] ?? null;

    // The last chunk whose partial source actually parsed. This is what the
    // viewer's iframe should be drawing: a chunk that never parsed would throw
    // on its first frame, and the audience would see "replay unavailable" where
    // a working render exists. Falls back to the finished source when every
    // chunk parsed (the normal case).
    const lastParsedIndex = previews.reduce(
      (best, preview) => (preview.parseOk ? preview.chunkIndex : best),
      -1,
    );
    const renderableCode =
      lastParsedIndex >= 0
        ? joinChunks(
            chunks.filter((chunk) => chunk.chunkIndex <= lastParsedIndex),
          )
        : code;

    const facts = {
      executionStatus: execution?.status ?? null,
      failureKind: execution?.failure_kind ?? null,
      artifactStored: artifact !== null,
      artifactGatePassed: artifact ? artifact.gatePassed : null,
      artifactUnavailable: artifact?.unavailable ?? false,
      judgeRuled: judge !== null,
      judgeVerdict: judge?.verdict ?? null,
    };

    const expected = expectedChunks(execution);

    progress.push({
      ...model,
      state: deriveModelState(facts),
      code,
      // What the quarantined iframe should run: the newest source that parsed.
      renderableCode,
      // "Compiling…" means the latest partial source could not be parsed yet —
      // the code is growing and the next chunk may still close the function.
      compiling: latest !== null && !latest.parseOk,
      previews,
      chunks: {
        generated: chunks.length,
        expected,
        // Every model fills the round's full chunk schedule, so the ceiling *is*
        // the finish line: a model is done when its generation succeeded or when
        // it has written every slot. A parseable chunk no longer means done —
        // a model that finishes early keeps extending the scene in its
        // remaining slots, and marking it complete at chunk 1 of 4 would show a
        // full bar while it is still writing.
        complete:
          execution?.status === "succeeded" ||
          (expected > 0 && chunks.length >= expected),
      },
      // One frame is enough to watch a still; the whole artifact would make
      // every poll megabytes. The full set lives on the results API.
      frames: artifact ? artifact.frames.slice(-1) : [],
      frameCount: artifact?.frameCount ?? 0,
      gatePassed: artifact?.gatePassed ?? null,
      judge,
      failure: deriveFailure(facts),
    });
  }

  const { data: outcomeRow } = await supabase
    .from("round_outcomes")
    .select("kind, winner_model_id, fan_favorite_model_id, reason")
    .eq("round_id", roundId)
    .maybeSingle();

  const retryMessage = RETRY_MESSAGES[round.status];

  return {
    roundId: round.id,
    slug: round.slug,
    status: round.status,
    revealed: true,
    brief: brief ? { title: brief.title, prompt: brief.prompt } : null,
    replay: {
      entryPoint: brief?.entry_point ?? "drawFrame",
      frameWidth: brief?.frame_width ?? 640,
      frameHeight: brief?.frame_height ?? 480,
      targetDurationMs: brief?.target_duration_ms ?? 4000,
      frameCount: brief?.frame_count ?? 24,
    },
    models: progress,
    retry: retryMessage ? { message: retryMessage } : null,
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

/** A model's progress before the round reveals anything. */
function emptyProgress(model: {
  modelId: string;
  name: string;
  ordinal: number;
}): LiveModelProgress {
  return {
    ...model,
    state: "pending",
    code: null,
    renderableCode: null,
    compiling: false,
    previews: [],
    chunks: { generated: 0, expected: 0, complete: false },
    frames: [],
    frameCount: 0,
    gatePassed: null,
    judge: null,
    failure: null,
  };
}

/**
 * The chunk ceiling this execution was run under.
 *
 * Read from the policy snapshot stored on the execution rather than from the
 * current environment: a round run under a three-chunk policy must still read
 * as three even if the deployment has since changed. Falls back to 0 when the
 * snapshot is missing, which the UI renders as an indeterminate count.
 */
function expectedChunks(execution: ExecutionRow | undefined): number {
  if (!execution) return 0;
  const config = execution.config as
    { chunkPolicy?: Partial<ChunkPolicy> } | null | undefined;
  const max = config?.chunkPolicy?.maxChunks;
  return typeof max === "number" && max > 0 ? max : 0;
}

/** The stored chunks for an execution, as the source-assembly joiner expects. */
async function readChunkSource(
  execution: ExecutionRow,
  supabase: SupabaseClient,
): Promise<Array<{ chunkIndex: number; source: string }>> {
  try {
    return await listChunks(execution.id, supabase);
  } catch {
    // A chunk read failing must not blank the whole live view; the finished
    // source (when there is one) is still a usable fallback.
    return [];
  }
}

async function readPreviews(
  executionId: string,
  supabase: SupabaseClient,
): Promise<LivePreview[]> {
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
): Promise<{
  gatePassed: boolean;
  unavailable: boolean;
  frameCount: number;
  frames: RenderedFrame[];
} | null> {
  const { data } = await supabase
    .from("rendered_artifacts")
    .select("gate_passed, unavailable, frame_count, frames")
    .eq("execution_id", executionId)
    .maybeSingle();

  if (!data) return null;

  const row = data as {
    gate_passed: boolean;
    unavailable: boolean;
    frame_count: number | null;
    frames: unknown;
  };

  return {
    gatePassed: row.gate_passed,
    unavailable: row.unavailable === true,
    frameCount: row.frame_count ?? 0,
    frames: Array.isArray(row.frames) ? (row.frames as RenderedFrame[]) : [],
  };
}
