"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  needsAccountSetup,
  usernameToLoginEmail,
} from "@/lib/auth/wallet-account";
import { getBrowserSupabase } from "@/lib/supabase/browser";

type Mode = "sign-in" | "sign-up";

// Social OAuth deferred — re-add when a provider is configured (ticket #4)

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function redirectTarget() {
    const next = searchParams.get("next");
    // Only same-origin absolute paths — reject protocol-relative "//host".
    if (next && next.startsWith("/") && !next.startsWith("//")) return next;
    return "/dashboard";
  }

  function finishAuth(override?: string) {
    router.push(override ?? redirectTarget());
    router.refresh();
  }

  function friendlyError(message: string) {
    if (message.includes("Invalid login credentials")) {
      return mode === "sign-in"
        ? "That username or email and password don't match. Try again or create an account."
        : "That email and password don't match. Try again or create an account.";
    }
    if (message.toLowerCase().includes("rate limit")) {
      return "Too many attempts. Supabase limits auth emails, so wait a few minutes and try again — or sign in if you already have an account.";
    }
    if (message.toLowerCase().includes("already registered")) {
      return "That email already has an account. Try signing in instead.";
    }
    if (message.toLowerCase().includes("user rejected")) {
      return "Wallet signature cancelled. Approve the request in Phantom to sign in.";
    }
    return message;
  }

  function toggleMode() {
    setMode(mode === "sign-in" ? "sign-up" : "sign-in");
    setError(null);
    setNotice(null);
  }

  async function handleSolanaLogin() {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      if (!window.solana) {
        throw new Error(
          "No Solana wallet found. Install Phantom, then reload this page.",
        );
      }
      const { data, error } = await getBrowserSupabase().auth.signInWithWeb3({
        chain: "solana",
        statement: "Sign in to AI Showdown to stake on rounds.",
        wallet: window.solana,
      });
      if (error) throw error;
      // A new wallet account finishes by choosing a username and password.
      finishAuth(needsAccountSetup(data.user) ? "/create-account" : undefined);
    } catch (err: unknown) {
      setError(
        friendlyError(
          err instanceof Error ? err.message : "Wallet sign-in failed",
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const supabase = getBrowserSupabase();
      if (mode === "sign-in") {
        // No "@" means a username from a Phantom sign-up.
        const identifier = email.trim();
        const { error } = await supabase.auth.signInWithPassword({
          email: identifier.includes("@")
            ? identifier
            : usernameToLoginEmail(identifier),
          password,
        });
        if (error) throw error;
        finishAuth();
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (data.user && !data.session) {
          setNotice("Check your email to confirm your account, then sign in.");
        } else {
          // First screen after email sign-up: offer the wallet link.
          finishAuth("/link-wallet");
        }
      }
    } catch (err: unknown) {
      setError(
        friendlyError(err instanceof Error ? err.message : "Login failed"),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-[380px]">
      <h1 className="t-title text-[1.75rem] text-ink">
        {mode === "sign-in" ? "Sign in" : "Create an account"}
      </h1>
      <p className="t-body mt-2.5 text-sm text-muted">
        {mode === "sign-in"
          ? "Stake before the deadline, then watch the renders land."
          : "Browse rounds right away. Link a wallet when you want to stake."}
      </p>

      {error ? (
        <p
          id="auth-error"
          role="alert"
          className="mt-6 rounded-lg border border-magenta/30 bg-magenta/[0.07] px-3.5 py-2.5 text-[0.8125rem] text-magenta"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="mt-6 rounded-lg border border-violet/30 bg-violet/[0.08] px-3.5 py-2.5 text-[0.8125rem] text-violet"
        >
          {notice}
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-7 space-y-4">
        <div>
          <label htmlFor="email" className="t-label mb-2 block text-faint">
            {mode === "sign-in" ? "Email or username" : "Email"}
          </label>
          <input
            id="email"
            type={mode === "sign-in" ? "text" : "email"}
            autoComplete={mode === "sign-in" ? "username" : "email"}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "auth-error" : undefined}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field"
          />
        </div>
        <div>
          <label htmlFor="password" className="t-label mb-2 block text-faint">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete={
              mode === "sign-in" ? "current-password" : "new-password"
            }
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "auth-error" : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="btn btn-solid btn-block"
        >
          {loading
            ? mode === "sign-in"
              ? "Signing in…"
              : "Creating account…"
            : mode === "sign-in"
              ? "Sign in"
              : "Create account"}
        </button>
      </form>

      <div className="my-7 flex items-center gap-4">
        <span aria-hidden="true" className="h-px flex-1 bg-hairline" />
        <span className="t-label text-[0.5625rem] text-faint">or</span>
        <span aria-hidden="true" className="h-px flex-1 bg-hairline" />
      </div>

      <button
        type="button"
        onClick={() => void handleSolanaLogin()}
        disabled={loading}
        className="btn btn-primary btn-block"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <path d="M6 15.5 8.5 8.5h9.5" strokeLinecap="round" />
          <path d="M8.5 8.5 18 15.5H8" strokeLinecap="round" />
          <circle cx="12" cy="12" r="9.2" opacity="0.35" />
        </svg>
        Sign in with Solana
      </button>
      <p className="t-body mt-3 text-center text-xs text-faint">
        Uses your Phantom wallet. New here? You will pick a username and
        password next, so you can sign back in either way.
      </p>

      <p className="t-body mt-7 text-center text-sm text-muted">
        {mode === "sign-in" ? (
          <>
            No account?{" "}
            <button
              type="button"
              onClick={toggleMode}
              className="font-medium text-ink underline decoration-magenta/50 underline-offset-4 hover:decoration-magenta"
            >
              Create one
            </button>
          </>
        ) : (
          <>
            Already have one?{" "}
            <button
              type="button"
              onClick={toggleMode}
              className="font-medium text-ink underline decoration-magenta/50 underline-offset-4 hover:decoration-magenta"
            >
              Sign in
            </button>
          </>
        )}
      </p>
    </div>
  );
}
