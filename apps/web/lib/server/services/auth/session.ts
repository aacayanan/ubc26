import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { User } from "@supabase/supabase-js";
import {
  AuthenticationError,
  AuthorizationError,
} from "@/lib/server/errors/app-error";
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

/**
 * The signed-in account's role, read from `public.users`.
 *
 * The `users.role` column is the only authority for this; nothing about the
 * session itself claims a role. Null means "not signed in" or "no profile".
 */
export const getCurrentRole = cache(
  async (): Promise<"user" | "admin" | null> => {
    const user = await getCurrentUser();
    if (!user) return null;

    const supabase = await getServerSupabase();
    const { data, error } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (error || !data) return null;

    return data.role === "admin" ? "admin" : "user";
  },
);

export const requireUser = cache(async (): Promise<User> => {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // F6: repair a missing profile row before any page reads it. This is
  // idempotent and costs one SELECT after the first signup; it does not run
  // on the proxy path, so it never adds latency to unauthenticated requests.
  await ensureProfile(user);

  return user;
});

/**
 * The signed-in user, asserting operator rights.
 *
 * Throws rather than redirecting so API routes and Server Components can both
 * use it: the route's error handler turns these into 401/403, a page can
 * catch `AuthorizationError` and redirect.
 */
export const requireAdmin = cache(async (): Promise<User> => {
  const user = await getCurrentUser();
  if (!user) throw new AuthenticationError();

  // Read the role directly rather than through `getCurrentRole()`: a request
  // that is refused must not be reported as "not signed in", which would send
  // the caller to the login page in a loop.
  const supabase = await getServerSupabase();
  const { data, error } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error || data?.role !== "admin") throw new AuthorizationError();

  return user;
});
