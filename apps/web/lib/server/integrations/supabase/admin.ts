import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleEnv } from "@/lib/config/server";

/**
 * Service-role Supabase client (F13, and later F17/F18).
 *
 * This client bypasses row-level security. It exists because the tables the
 * evaluation pipeline writes — `model_executions`, `test_results` — have a
 * public SELECT policy and deliberately no write policy, so only the service
 * role can insert results.
 *
 * Rules for anything holding this client:
 * - never return it, or data read through it, from a route handler as-is;
 * - never let a request-derived value choose the query's target table or filters
 *   without validation;
 * - it must never reach the client bundle (`server-only` enforces that here).
 */
export function getServiceRoleSupabase(): SupabaseClient {
  const { supabaseUrl, supabaseServiceRoleKey } = getServiceRoleEnv();

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      // Background work has no session to persist or refresh.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
