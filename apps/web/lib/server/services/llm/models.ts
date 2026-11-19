import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { InternalError, NotFoundError } from "@/lib/server/errors/app-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";

/**
 * The lineup, read from `llm_models` (F16).
 *
 * The three models are configuration, not code: whichever active rows exist,
 * ordered by `sort_order`, are the competition lineup. That is why nothing in
 * the client or the prompt names a provider — adding or swapping a model is a
 * table edit, and old executions keep their snapshot of what ran.
 *
 * Reads use the service role so the lineup is visible to background work with
 * no user session. The table itself is world-readable; this is not a secret,
 * only a convenient stable order.
 */

export interface LLMModelRecord {
  id: string;
  slug: string;
  name: string;
  provider: string;
  openrouterModelId: string;
  config: Record<string, unknown>;
  sortOrder: number;
}

interface LLMModelRow {
  id: string;
  slug: string;
  name: string;
  provider: string;
  openrouter_model_id: string;
  config: unknown;
  sort_order: number;
}

const COLUMNS =
  "id, slug, name, provider, openrouter_model_id, config, sort_order";

function toRecord(row: LLMModelRow): LLMModelRecord {
  const config =
    row.config && typeof row.config === "object" && !Array.isArray(row.config)
      ? (row.config as Record<string, unknown>)
      : {};

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    provider: row.provider,
    openrouterModelId: row.openrouter_model_id,
    config,
    sortOrder: row.sort_order,
  };
}

export async function getActiveLineup(
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<LLMModelRecord[]> {
  const { data, error } = await supabase
    .from("llm_models")
    .select(COLUMNS)
    .eq("is_active", true)
    // `sort_order` alone is not a stable order when two rows share a value.
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    throw new InternalError("Failed to load the model lineup", error);
  }

  return ((data ?? []) as LLMModelRow[]).map(toRecord);
}

export async function getLineupModel(
  slug: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<LLMModelRecord> {
  const { data, error } = await supabase
    .from("llm_models")
    .select(COLUMNS)
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new InternalError("Failed to load the model", error);
  }

  if (!data) {
    throw new NotFoundError(`No active model with slug "${slug}"`);
  }

  return toRecord(data as LLMModelRow);
}
