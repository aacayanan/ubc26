import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user) {
      const { data: profile } = await supabase
        .from("users")
        .select("role")
        .eq("id", data.user.id)
        .maybeSingle();

      return NextResponse.redirect(
        new URL(
          profile?.role === "admin" ? "/admin" : "/dashboard",
          request.url,
        ),
      );
    }
  }

  return NextResponse.redirect(new URL("/dashboard", request.url));
}
