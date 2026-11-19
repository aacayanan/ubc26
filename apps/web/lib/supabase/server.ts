import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getClientEnv } from "@/lib/config/client";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { supabaseUrl, supabasePublishableKey } = getClientEnv();

  return createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot always write cookies; proxy refreshes them.
        }
      },
    },
  });
}
