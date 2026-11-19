import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeterministicCheck, JudgeCriterion } from "@ai-showdown/shared";
import { InternalError, NotFoundError } from "@/lib/server/errors/app-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";

/**
 * The visual brief bank (F12).
 *
 * A brief is a `public.challenges` row with `language = 'javascript'`. The
 * database owns the rules that must hold under any caller — versioning,
 * completeness, the publish gate — and this module is the typed doorway:
 * seeding goes through `seed_brief()`, publishing through `publish_brief()`.
 *
 * Both are RPCs on purpose. Re-implementing the fingerprint or the publish
 * checks in TypeScript would give two sources of truth, and the SQL assertions
 * in `supabase/tests/briefs.sql` would then be testing a rule the app does not
 * follow.
 */

/** The seed document, in the shape `seed_brief(jsonb)` consumes. */
export interface BriefSeedDocument {
  slug: string;
  title: string;
  prompt: string;
  styleConstraints: string;
  entryPoint: string;
  targetDurationMs: number;
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
  deterministicChecks: DeterministicCheck[];
  judgeRubric: JudgeCriterion[];
  starterCode?: string;
  referenceImpl: string;
}

/** A published brief, as the pipeline (F17) and judge (F31) need it. */
export interface BriefRecord {
  id: string;
  slug: string;
  version: number;
  title: string;
  prompt: string;
  styleConstraints: string;
  entryPoint: string;
  targetDurationMs: number;
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
  deterministicChecks: DeterministicCheck[];
  judgeRubric: JudgeCriterion[];
  starterCode: string;
  referenceImpl: string;
  referenceValidatedAt: string | null;
}

export interface SeedBriefResult {
  slug: string;
  version: number;
  action: "inserted" | "unchanged";
}

/**
 * Convert the camelCase document to the snake_case JSON the RPC expects.
 *
 * Kept explicit rather than a generic key-mapper: the database column names are
 * part of the contract, and a silent rename here would seed a brief with a null
 * field instead of failing.
 */
export function toSeedPayload(doc: BriefSeedDocument): Record<string, unknown> {
  return {
    slug: doc.slug,
    title: doc.title,
    prompt: doc.prompt,
    style_constraints: doc.styleConstraints,
    entry_point: doc.entryPoint,
    target_duration_ms: doc.targetDurationMs,
    frame_count: doc.frameCount,
    frame_width: doc.frameWidth,
    frame_height: doc.frameHeight,
    deterministic_checks: doc.deterministicChecks,
    judge_rubric: doc.judgeRubric,
    starter_code: doc.starterCode ?? "",
    reference_impl: doc.referenceImpl,
    language: "javascript",
  };
}

export async function seedBrief(
  doc: BriefSeedDocument,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<SeedBriefResult> {
  const { data, error } = await supabase.rpc("seed_brief", {
    doc: toSeedPayload(doc),
  });

  if (error) {
    throw new InternalError("Failed to seed the brief", error);
  }

  // The RPC returns a one-row table (slug, version, action).
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new InternalError("seed_brief returned no row");
  }

  return {
    slug: row.slug as string,
    version: row.version as number,
    action: row.action as "inserted" | "unchanged",
  };
}

/**
 * Publish a brief that has passed a real reference render.
 *
 * The caller is the validation script, and only after `runReferenceRender`
 * succeeded — the database re-checks completeness, but it cannot know a render
 * happened, so the image digest is recorded here as the evidence.
 */
export async function publishBrief(
  params: { slug: string; version: number; imageDigest: string | null },
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<void> {
  const { error } = await supabase.rpc("publish_brief", {
    p_slug: params.slug,
    p_version: params.version,
    p_image_digest: params.imageDigest,
  });

  if (error) {
    throw new InternalError("Failed to publish the brief", error);
  }
}

interface BriefRow {
  id: string;
  slug: string;
  version: number;
  title: string;
  prompt: string;
  style_constraints: string | null;
  entry_point: string | null;
  target_duration_ms: number | null;
  frame_count: number | null;
  frame_width: number | null;
  frame_height: number | null;
  deterministic_checks: unknown;
  judge_rubric: unknown;
  starter_code: string;
  reference_impl: string | null;
  reference_validated_at: string | null;
}

// A single literal, not a concatenation: supabase-js infers the row type from
// the select string, and a widened `string` collapses it to a generic error
// type.
const BRIEF_COLUMNS =
  "id, slug, version, title, prompt, style_constraints, entry_point, target_duration_ms, frame_count, frame_width, frame_height, deterministic_checks, judge_rubric, starter_code, reference_impl, reference_validated_at";

function asChecks(value: unknown): DeterministicCheck[] {
  return Array.isArray(value) ? (value as DeterministicCheck[]) : [];
}

function asRubric(value: unknown): JudgeCriterion[] {
  return Array.isArray(value) ? (value as JudgeCriterion[]) : [];
}

function toBrief(row: BriefRow): BriefRecord {
  // A published brief is guaranteed complete by the database, so the non-null
  // assertions below are safe for the only rows this reader accepts.
  return {
    id: row.id,
    slug: row.slug,
    version: row.version,
    title: row.title,
    prompt: row.prompt,
    styleConstraints: row.style_constraints ?? "",
    entryPoint: row.entry_point ?? "",
    targetDurationMs: row.target_duration_ms ?? 0,
    frameCount: row.frame_count ?? 0,
    frameWidth: row.frame_width ?? 0,
    frameHeight: row.frame_height ?? 0,
    deterministicChecks: asChecks(row.deterministic_checks),
    judgeRubric: asRubric(row.judge_rubric),
    starterCode: row.starter_code,
    referenceImpl: row.reference_impl ?? "",
    referenceValidatedAt: row.reference_validated_at,
  };
}

/** The latest published version of a brief, or null. */
export async function getPublishedBrief(
  slug: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<BriefRecord | null> {
  const { data, error } = await supabase
    .from("challenges")
    .select(BRIEF_COLUMNS)
    .eq("slug", slug)
    .eq("language", "javascript")
    .eq("status", "published")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new InternalError("Failed to read the brief", error);
  }

  return data ? toBrief(data as BriefRow) : null;
}

/** Every published brief, newest version of each slug first. */
export async function listPublishedBriefs(
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<BriefRecord[]> {
  const { data, error } = await supabase
    .from("challenges")
    .select(BRIEF_COLUMNS)
    .eq("language", "javascript")
    .eq("status", "published")
    .order("slug", { ascending: true })
    .order("version", { ascending: false });

  if (error) {
    throw new InternalError("Failed to list briefs", error);
  }

  const rows = (data ?? []) as BriefRow[];
  // One row per slug: the highest version wins.
  const latest = new Map<string, BriefRow>();
  for (const row of rows) {
    if (!latest.has(row.slug)) latest.set(row.slug, row);
  }

  return [...latest.values()].map(toBrief);
}

/** A specific version, published or not — used by the validation script. */
export async function getBriefVersion(
  slug: string,
  version: number,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<BriefRecord> {
  const { data, error } = await supabase
    .from("challenges")
    .select(BRIEF_COLUMNS)
    .eq("slug", slug)
    .eq("version", version)
    .eq("language", "javascript")
    .maybeSingle();

  if (error) {
    throw new InternalError("Failed to read the brief version", error);
  }

  if (!data) {
    throw new NotFoundError(`Brief ${slug} v${version} does not exist`);
  }

  return toBrief(data as BriefRow);
}

/**
 * A brief by row id.
 *
 * A round pins `challenge_id` — a specific *version* — so the pipeline must read
 * the brief it was opened against rather than the newest published version of
 * the same slug. Returning null (rather than throwing) lets the caller report
 * "this round's brief is missing" as its own conflict.
 */
export async function getBriefById(
  challengeId: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<BriefRecord | null> {
  const { data, error } = await supabase
    .from("challenges")
    .select(BRIEF_COLUMNS)
    .eq("id", challengeId)
    .eq("language", "javascript")
    .maybeSingle();

  if (error) {
    throw new InternalError("Failed to read the brief", error);
  }

  return data ? toBrief(data as BriefRow) : null;
}
