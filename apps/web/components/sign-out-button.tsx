"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase/browser";

export default function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleSignOut() {
    setLoading(true);
    setFailed(false);
    try {
      await getBrowserSupabase().auth.signOut();
      router.push("/");
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={loading}
      className="btn btn-ghost btn-sm"
    >
      {loading
        ? "Signing out…"
        : failed
          ? "Couldn’t sign out — retry"
          : "Sign out"}
    </button>
  );
}
