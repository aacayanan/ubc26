import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { User } from "@supabase/supabase-js";
import { getServerSupabase } from "@/lib/server/integrations/supabase/server";
import { ensureProfile } from "@/lib/server/services/profile/profile";

export const getCurrentUser = cache(async (): Promise<User | null> => {
  // Read the session at request time only.
  //
  // The Supabase auth client compares `expires_at` against `Date.now()` to
  // decide whether to refresh. With `partialPrefetching`, Next also runs
  // runtime prerenders, and those *permit* `cookies()` — so the session read
  // was allowed to proceed there and then tripped the blocking-prerender
  // current-time check. `connection()` stalls those passes and pins everything
  // downstream to a real request, which is what a session read already needs.
  await connection();

  try {
    const supabase = await getServerSupabase();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error) return null;
    return user;
  } catch {
    return null;
  }
});

export const requireUser = cache(async (): Promise<User> => {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // F6: repair a missing profile row before any page reads it. This is
  // idempotent and costs one SELECT after the first signup; it does not run
  // on the proxy path, so it never adds latency to unauthenticated requests.
  await ensureProfile(user);

  return user;
});
