import "server-only";

import { InternalError, ValidationError } from "@/lib/server/errors/app-error";
import { getCorrelationId } from "@/lib/server/http/api-error";
import { logger } from "@/lib/server/logging/logger";
import { getServerSupabase } from "@/lib/server/integrations/supabase/server";

const MAX_DISPLAY_NAME_LENGTH = 40;

/** Normalize and validate a display name; empty input clears the field. */
export function parseDisplayName(input: unknown): string | null {
  if (typeof input !== "string") {
    throw new ValidationError("Display name must be text");
  }

  const trimmed = input.trim().replace(/\s+/g, " ");

  if (trimmed.length === 0) return null;

  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ValidationError(
      `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
    );
  }

  return trimmed;
}

/**
 * Update the caller's own profile.
 *
 * Runs on the request-scoped client under RLS: `users_update_own` plus the
 * column grant limit writes to `display_name`/`avatar_url`, so `role` and
 * `funded` stay server-set even if this function were called with other keys.
 */
export async function updateDisplayName(
  userId: string,
  input: unknown,
): Promise<string | null> {
  const displayName = parseDisplayName(input);
  const supabase = await getServerSupabase();

  const { error } = await supabase
    .from("users")
    .update({ display_name: displayName })
    .eq("id", userId);

  if (error) {
    throw new InternalError("Failed to update your display name", error);
  }

  logger.info("profile.display_name.updated", {
    correlationId: getCorrelationId(),
    userId,
  });

  return displayName;
}
