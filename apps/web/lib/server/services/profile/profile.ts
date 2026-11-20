import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  InternalError,
  NotFoundError,
  normalizeError,
} from "@/lib/server/errors/app-error";
import { getCorrelationId } from "@/lib/server/http/api-error";
import { logger } from "@/lib/server/logging/logger";
import { getServerSupabase } from "@/lib/server/integrations/supabase/server";

/**
 * Server-authoritative view of the signed-in account.
 *
 * Prediction counts come from the user's own Devnet SOL wagers
 * (`public.wagers`, owner-readable under RLS). `predictions` counts accepted
 * wagers; `correctPredictions` counts the ones settlement marked `won`.
 */
export interface Profile {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  predictions: number;
  correctPredictions: number;
  practiceMode: boolean;
  funded: boolean;
  createdAt: string;
}

interface ProfileRow {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  practice_mode: boolean;
  funded: boolean;
  created_at: string;
}

/**
 * Read the account's profile and prediction counts.
 *
 * Throws `NotFoundError` when the profile row is genuinely missing so callers
 * can surface an actionable message instead of a generic failure; any query
 * error becomes an `InternalError` carrying the original as `cause`.
 */
export async function getProfile(
  user: User,
  supabase?: SupabaseClient,
): Promise<Profile> {
  const client = supabase ?? (await getServerSupabase());
  const { data, error } = await client
    .from("users")
    .select("id, display_name, avatar_url, practice_mode, funded, created_at")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    throw new InternalError("Failed to load your profile", error);
  }
  if (!data) {
    throw new NotFoundError("Your profile has not been set up yet");
  }

  const profile = data as ProfileRow;

  const [total, correct] = await Promise.all([
    client
      .from("wagers")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "accepted"),
    client
      .from("wagers")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "accepted")
      .eq("settlement_outcome", "won"),
  ]);

  if (total.error || correct.error) {
    throw new InternalError(
      "Failed to load your predictions",
      total.error ?? correct.error,
    );
  }

  return {
    id: profile.id,
    email: user.email ?? null,
    displayName: profile.display_name,
    avatarUrl: profile.avatar_url,
    predictions: total.count ?? 0,
    correctPredictions: correct.count ?? 0,
    practiceMode: profile.practice_mode === true,
    funded: profile.funded === true,
    createdAt: profile.created_at,
  };
}

/**
 * Make sure the account has a profile row.
 *
 * The `handle_new_user()` trigger normally does this at signup, so this is a
 * repair path for accounts created before that trigger existed. It is
 * idempotent and inserts only `id`: the remaining columns have defaults.
 *
 * Returns true when a row had to be created.
 */
export async function ensureProfile(user: User): Promise<boolean> {
  const supabase = await getServerSupabase();

  const { data: existing, error: readError } = await supabase
    .from("users")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (readError) {
    throw new InternalError("Failed to check your profile", readError);
  }
  if (existing) return false;

  const { error: insertError } = await supabase
    .from("users")
    .insert({ id: user.id })
    .select("id")
    .single();

  // A concurrent request may have won the race; the unique key turns that
  // into a duplicate-key error, which is success for our purposes.
  if (insertError && !isDuplicateKey(insertError)) {
    throw new InternalError("Failed to create your profile", insertError);
  }

  const correlationId = getCorrelationId();
  logger.info("profile.sync.created", {
    correlationId,
    userId: user.id,
  });

  return true;
}

/** Read the profile, repairing the row first if it is missing. */
export async function getOrRepairProfile(user: User): Promise<Profile> {
  try {
    return await getProfile(user);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw normalizeError(error);

    const created = await ensureProfile(user);
    logger.warn("profile.missing.repaired", {
      correlationId: getCorrelationId(),
      userId: user.id,
      created,
    });

    return getProfile(user);
  }
}

function isDuplicateKey(error: { code?: string }): boolean {
  // 23505 = unique_violation.
  return error.code === "23505";
}
