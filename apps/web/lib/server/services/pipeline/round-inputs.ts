import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoundStatus } from "@ai-showdown/shared";
import {
  ConflictError,
  InternalError,
  NotFoundError,
} from "@/lib/server/errors/app-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import {
  getBriefById,
  type BriefRecord,
} from "@/lib/server/services/briefs/briefs";
import type { LLMModelRecord } from "@/lib/server/services/llm/models";

/**
 * Reading the inputs a round's pipeline run needs (F17).
 *
 * A round pins an exact `challenge_id` (a brief version), and its participants
 * come from `round_models` rather than from the active lineup: the lineup is
 * today's configuration, while a round was opened against a specific set of
 * models that backers already staked on. Reading the lineup here would let a
 * catalog edit mid-round change who competes — and therefore who could win a pot
 * that was already staked.
 */

export interface RoundParticipant extends LLMModelRecord {
  /** `round_models.ordinal` — the stable order F15's tiebreak depends on. */
  ordinal: number;
}

export interface RoundRunInputs {
  roundId: string;
  slug: string;
  status: RoundStatus;
  brief: BriefRecord;
  participants: RoundParticipant[];
}

interface RoundRow {
  id: string;
  slug: string;
  status: RoundStatus;
  challenge_id: string;
}

/**
 * Load a round's brief and participants.
 *
 * Throws `NotFoundError` for an unknown round and `ConflictError` when the round
 * is not in a state the pipeline may run — the caller is expected to ask first
 * (`assertRunnable`), and this is the second check for the resume path.
 */
export async function loadRoundRunInputs(
  roundId: string,
  supabase: SupabaseClient = getServiceRoleSupabase(),
): Promise<RoundRunInputs> {
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

  const round = roundData as RoundRow;

  // The round pins a version; read it by id so a newer published version of the
  // same slug cannot swap the brief under a round that already ran.
  const brief = await getBriefById(round.challenge_id, supabase);

  if (!brief) {
    throw new ConflictError(
      `Round ${round.slug} is missing its brief (${round.challenge_id}) or it is not a JavaScript brief`,
    );
  }

  const { data: modelRows, error: modelError } = await supabase
    .from("round_models")
    .select(
      "ordinal, llm_models(id, slug, name, provider, openrouter_model_id, config, sort_order, role)",
    )
    .eq("round_id", roundId)
    .order("ordinal", { ascending: true })
    .order("model_id", { ascending: true });

  if (modelError) {
    throw new InternalError("Failed to read the round's models", modelError);
  }

  const participants: RoundParticipant[] = [];

  for (const row of (modelRows ?? []) as Array<{
    ordinal: number;
    llm_models:
      | {
          id: string;
          slug: string;
          name: string;
          provider: string;
          openrouter_model_id: string;
          config: unknown;
          sort_order: number;
          role: "competitor" | "judge";
        }
      | Array<{
          id: string;
          slug: string;
          name: string;
          provider: string;
          openrouter_model_id: string;
          config: unknown;
          sort_order: number;
          role: "competitor" | "judge";
        }>;
  }>) {
    // The embedded relation is an object for a to-one join, but supabase-js
    // types it as an array in some generated shapes; handle both.
    const model = Array.isArray(row.llm_models)
      ? row.llm_models[0]
      : row.llm_models;

    if (!model) continue;

    participants.push({
      id: model.id,
      slug: model.slug,
      name: model.name,
      provider: model.provider,
      openrouterModelId: model.openrouter_model_id,
      config:
        model.config &&
        typeof model.config === "object" &&
        !Array.isArray(model.config)
          ? (model.config as Record<string, unknown>)
          : {},
      sortOrder: model.sort_order,
      role: model.role,
      ordinal: row.ordinal,
    });
  }

  if (participants.length === 0) {
    throw new ConflictError(`Round ${round.slug} has no participating models`);
  }

  return {
    roundId: round.id,
    slug: round.slug,
    status: round.status,
    brief,
    participants,
  };
}
