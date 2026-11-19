import "server-only";

import { ConfigurationError } from "@/lib/server/errors/app-error";
import { getClientEnv } from "@/lib/config/client";

export interface ServerEnv {
  openRouterApiKey: string;
}

export interface ServiceRoleEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

export interface InternalJobEnv {
  /**
   * Shared secret for the internal job endpoints (F11 deadline lock today;
   * the F17 pipeline trigger later). Unset means the endpoints refuse to run,
   * so an unconfigured deployment fails closed instead of accepting anonymous
   * calls.
   */
  internalJobSecret: string;
}

export function getServerEnv(): ServerEnv {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;

  if (!openRouterApiKey) {
    throw new ConfigurationError("Missing OPENROUTER_API_KEY");
  }

  return {
    openRouterApiKey,
  };
}

/**
 * Service-role credentials for background writes.
 *
 * Kept separate from `getServerEnv()` on purpose: the pages that already call
 * `getServerEnv()` must keep working, and a missing service-role key should
 * only break the code paths that genuinely need to bypass RLS (evaluation
 * result writes, F13).
 */
export function getServiceRoleEnv(): ServiceRoleEnv {
  const { supabaseUrl } = getClientEnv();
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseServiceRoleKey) {
    throw new ConfigurationError("Missing SUPABASE_SERVICE_ROLE_KEY");
  }

  return {
    supabaseUrl,
    supabaseServiceRoleKey,
  };
}

export function getInternalJobEnv(): InternalJobEnv {
  const internalJobSecret = process.env.INTERNAL_JOB_SECRET;

  if (!internalJobSecret) {
    throw new ConfigurationError("Missing INTERNAL_JOB_SECRET");
  }

  return { internalJobSecret };
}
