import "server-only";

import { redirect } from "next/navigation";

import {
  AuthenticationError,
  AuthorizationError,
} from "@/lib/server/errors/app-error";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface AuthenticatedUser {
  id: string;
  role: "user" | "admin";
}

export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return null;
  }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError || !profile) {
    return null;
  }

  return {
    id: user.id,
    role: profile.role,
  };
}

export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser();

  if (!user) {
    throw new AuthenticationError();
  }

  return user;
}

export async function requireAdmin(): Promise<AuthenticatedUser> {
  const user = await requireUser();

  if (user.role !== "admin") {
    throw new AuthorizationError();
  }

  return user;
}

export async function redirectForDashboard(): Promise<never> {
  const user = await getAuthenticatedUser();

  if (!user) {
    redirect("/login");
  }

  redirect(user.role === "admin" ? "/admin" : "/dashboard");
}

export async function getAdminDataClient() {
  await requireAdmin();
  return createSupabaseAdminClient();
}
