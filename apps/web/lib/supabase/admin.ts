import "server-only";

import { createClient } from "@supabase/supabase-js";

import { ConfigurationError } from "@/lib/server/errors/app-error";

export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new ConfigurationError(
      "Missing Supabase server configuration for administrative operations",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
