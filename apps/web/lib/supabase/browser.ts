import { createBrowserClient } from "@supabase/ssr";
import { getClientEnv } from "@/lib/config/client";

let client: ReturnType<typeof createBrowserClient> | null = null;

export function getBrowserSupabase() {
  if (!client) {
    const { supabaseUrl, supabasePublishableKey } = getClientEnv();
    client = createBrowserClient(supabaseUrl, supabasePublishableKey);
  }
  return client;
}
