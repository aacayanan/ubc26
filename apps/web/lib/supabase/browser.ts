import { createBrowserClient } from "@supabase/ssr";

import { getClientEnv } from "@/lib/config/client";

export function createSupabaseBrowserClient() {
  const { supabaseUrl, supabasePublishableKey } = getClientEnv();

  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}
