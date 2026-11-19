import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RenderedFrame } from "@ai-showdown/shared";
import { InternalError } from "@/lib/server/errors/app-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";

/**
 * Writes and reads for the F17 pipeline tables.
 *
 * Every write here is an upsert against a key the schema owns
 * (`generation_chunks(execution_id, chunk_index)`,
 * `render_previews(execution_id, chunk_index)`,
 * `judge_verdicts(execution_id)`), which is the whole mechanism behind
 * "restarting after interruption does not duplicate completed records". A resume
 * reads what exists, skips it, and continues; it never appends a second copy.
 *
 * `rendered_artifacts` is deliberately absent — the progressive preview writes
 * to `render_previews` so a partial render never becomes an artifact (F14).
 */

/** Frames stored per preview: enough to show growth, not a full artifact. */
export const PREVIEW_FRAME_LIMIT = 4;

export interface ChunkUpsert {
  executionId: string;
  chunkIndex: number;
  source: string;
  promptTemplateVersion: string;
  promptSha256: string;
  finishReason: string | null;
  outputTokens: number | null;
  attemptCount: number;
}

export async function upsertChunk(
  row: ChunkUpsert,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<void> {
  const { error } = await supabase.from("generation_chunks").upsert(
    {
      execution_id: row.executionId,
      chunk_index: row.chunkIndex,
      source: row.source,
      prompt_template_version: row.promptTemplateVersion,
      prompt_sha256: row.promptSha256,
      finish_reason: row.finishReason,
      output_tokens: row.outputTokens,
      attempt_count: row.attemptCount,
    },
    { onConflict: "execution_id,chunk_index" },
  );

  if (error) {
    throw new InternalError("Failed to record a generation chunk", error);
  }
}

/** A chunk read back for a resume: what it added and whether it was terminal. */
export interface ExistingChunk {
  chunkIndex: number;
  source: string;
  /** `stop` means the model finished its answer on this chunk. */
  finishReason: string | null;
}

/** Every stored chunk for an execution, ordered — the resume read. */
export async function listChunks(
  executionId: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<ExistingChunk[]> {
  const { data, error } = await supabase
    .from("generation_chunks")
    .select("chunk_index, source, finish_reason")
    .eq("execution_id", executionId)
    .order("chunk_index", { ascending: true });

  if (error) {
    throw new InternalError("Failed to read generation chunks", error);
  }

  return (
    (data ?? []) as Array<{
      chunk_index: number;
      source: string;
      finish_reason: string | null;
    }>
  ).map((row) => ({
    chunkIndex: row.chunk_index,
    source: row.source,
    finishReason: row.finish_reason,
  }));
}

export interface PreviewUpsert {
  executionId: string;
  chunkIndex: number;
  parseOk: boolean;
  rendered: boolean;
  error: string | null;
  frames: RenderedFrame[];
  imageDigest: string | null;
  wallMs: number | null;
}

export async function upsertPreview(
  row: PreviewUpsert,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<void> {
  const { error } = await supabase.from("render_previews").upsert(
    {
      execution_id: row.executionId,
      chunk_index: row.chunkIndex,
      parse_ok: row.parseOk,
      rendered: row.rendered,
      error: row.error,
      // A preview is capped rather than stored whole: the audience needs to see
      // motion, and four frames is plenty for a thumbnail strip.
      frames: row.frames.slice(0, PREVIEW_FRAME_LIMIT),
      image_digest: row.imageDigest,
      wall_ms: row.wallMs,
    },
    { onConflict: "execution_id,chunk_index" },
  );

  if (error) {
    throw new InternalError("Failed to record a render preview", error);
  }
}

/** Chunk indices that already have a preview — a resume republishes, never re-renders. */
export async function listPreviewedChunks(
  executionId: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<Set<number>> {
  const { data, error } = await supabase
    .from("render_previews")
    .select("chunk_index")
    .eq("execution_id", executionId);

  if (error) {
    throw new InternalError("Failed to read render previews", error);
  }

  return new Set(
    ((data ?? []) as Array<{ chunk_index: number }>).map((r) => r.chunk_index),
  );
}

export interface JudgeVerdictUpsert {
  executionId: string;
  roundId: string;
  subjectModelId: string;
  verdict: "conformed" | "not_conformed" | "unavailable";
  reason: string;
  criteria: Array<{
    id: string;
    question: string;
    weight: number;
    passed: boolean;
    reason: string;
  }>;
  rubricSha256: string | null;
}

/**
 * Record one ruling.
 *
 * Two unique keys guard this: `execution_id` (one ruling per judge call) and
 * `(round_id, subject_model_id)` (one ruling per subject per round, so a
 * re-judge replaces rather than stacking). The upsert targets the execution key;
 * the second constraint is satisfied because a re-judge reuses the same
 * execution row via `upsertExecution`'s composite key.
 */
export async function upsertJudgeVerdict(
  row: JudgeVerdictUpsert,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<void> {
  const { error } = await supabase.from("judge_verdicts").upsert(
    {
      execution_id: row.executionId,
      round_id: row.roundId,
      subject_model_id: row.subjectModelId,
      verdict: row.verdict,
      reason: row.reason,
      criteria: row.criteria,
      rubric_sha256: row.rubricSha256,
    },
    { onConflict: "execution_id" },
  );

  if (error) {
    throw new InternalError("Failed to record the judge verdict", error);
  }
}

export interface StoredJudgeVerdict {
  subjectModelId: string;
  verdict: "conformed" | "not_conformed" | "unavailable";
  reason: string;
  criteria: StoredCriterion[];
}

/** A stored per-criterion ruling, as the results and progress views read it. */
export interface StoredCriterion {
  id: string;
  question: string;
  /** Missing on rulings recorded before weights were stored; treated as 0. */
  weight: number;
  passed: boolean;
  reason: string;
}

/**
 * Read stored criteria defensively.
 *
 * Weights were added to the stored shape with F31; a verdict written before that
 * has no `weight`, and a results view must still render it rather than throw on
 * a public row. Normalising here means every reader sees the same shape.
 */
function toStoredCriteria(value: unknown): StoredCriterion[] {
  if (!Array.isArray(value)) return [];

  return (value as Array<Record<string, unknown>>).map((entry) => ({
    id: typeof entry.id === "string" ? entry.id : "",
    question: typeof entry.question === "string" ? entry.question : "",
    weight: typeof entry.weight === "number" ? entry.weight : 0,
    passed: entry.passed === true,
    reason: typeof entry.reason === "string" ? entry.reason : "",
  }));
}

/** The rulings recorded for a round, keyed for the resolver and results view. */
export async function listJudgeVerdicts(
  roundId: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<StoredJudgeVerdict[]> {
  const { data, error } = await supabase
    .from("judge_verdicts")
    .select("subject_model_id, verdict, reason, criteria")
    .eq("round_id", roundId);

  if (error) {
    throw new InternalError("Failed to read judge verdicts", error);
  }

  return (
    (data ?? []) as Array<{
      subject_model_id: string;
      verdict: StoredJudgeVerdict["verdict"];
      reason: string;
      criteria: unknown;
    }>
  ).map((row) => ({
    subjectModelId: row.subject_model_id,
    verdict: row.verdict,
    reason: row.reason,
    criteria: toStoredCriteria(row.criteria),
  }));
}

/**
 * One subject's existing ruling, or null.
 *
 * The resume read for the judge stage: a restart re-uses a stored ruling instead
 * of spending another judge call, which is what stops a crash mid-round from
 * re-judging every model that already had a verdict.
 */
export async function getJudgeVerdict(
  roundId: string,
  subjectModelId: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<StoredJudgeVerdict | null> {
  const { data, error } = await supabase
    .from("judge_verdicts")
    .select("subject_model_id, verdict, reason, criteria")
    .eq("round_id", roundId)
    .eq("subject_model_id", subjectModelId)
    .maybeSingle();

  if (error) {
    throw new InternalError("Failed to read the judge verdict", error);
  }

  if (!data) return null;

  const row = data as {
    subject_model_id: string;
    verdict: StoredJudgeVerdict["verdict"];
    reason: string;
    criteria: unknown;
  };

  return {
    subjectModelId: row.subject_model_id,
    verdict: row.verdict,
    reason: row.reason,
    criteria: toStoredCriteria(row.criteria),
  };
}
