import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getClientEnv } from "@/lib/config/client";

export async function getServerSupabase() {
  const { supabaseUrl, supabasePublishableKey } = getClientEnv();
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Cookie writes can throw mid-render or inside a Server Action after
          // the response has started — skip the write instead of failing the
          // request; the client keeps whatever session it already had.
        }
      },
    },
  });
}
