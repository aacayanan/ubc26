"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Status } from "@/components/ui";
import {
  MIN_PASSWORD_LENGTH,
  USERNAME_PATTERN,
  USERNAME_RULE,
} from "@/lib/auth/wallet-account";
import { getBrowserSupabase } from "@/lib/supabase/browser";

export function CreateAccountForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = username.trim();
    if (!USERNAME_PATTERN.test(trimmed)) {
      setError(`Username must be ${USERNAME_RULE}`);
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/account/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: trimmed, password }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          body?.error?.message ?? "Could not finish creating your account",
        );
      }
      // Pick up the new login details in the session cookie before leaving,
      // or the proxy would still see an unfinished account.
      await getBrowserSupabase().auth.refreshSession();
      router.push("/dashboard");
      router.refresh();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not finish creating your account",
      );
      setLoading(false);
    }
  }

  async function handleCancel() {
    await getBrowserSupabase().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="w-full max-w-[380px]">
      <Status tone="live">Wallet connected</Status>
      <h1 className="t-title mt-4 text-[1.75rem] text-ink">
        Create your account
      </h1>
      <p className="t-body mt-2.5 text-sm text-muted">
        Your Phantom wallet is linked. Choose a username and password so you can
        sign back in with or without the wallet.
      </p>

      {error ? (
        <p
          id="setup-error"
          role="alert"
          className="mt-6 rounded-lg border border-magenta/30 bg-magenta/[0.07] px-3.5 py-2.5 text-[0.8125rem] text-magenta"
        >
          {error}
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-7 space-y-4">
        <div>
          <label htmlFor="username" className="t-label mb-2 block text-faint">
            Username
          </label>
          <input
            id="username"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-describedby="username-hint"
            aria-invalid={error ? true : undefined}
            className="field"
          />
          <p
            id="username-hint"
            className="t-mono mt-2 text-[0.625rem] text-faint"
          >
            {USERNAME_RULE} Shown on the leaderboard.
          </p>
        </div>
        <div>
          <label htmlFor="password" className="t-label mb-2 block text-faint">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
            className="field"
          />
        </div>
        <div>
          <label htmlFor="confirm" className="t-label mb-2 block text-faint">
            Confirm password
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={error ? true : undefined}
            className="field"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="btn btn-solid btn-block"
        >
          {loading ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p className="t-body mt-7 text-center text-sm text-muted">
        Not you?{" "}
        <button
          type="button"
          onClick={() => void handleCancel()}
          className="font-medium text-ink underline decoration-magenta/50 underline-offset-4 hover:decoration-magenta"
        >
          Sign out
        </button>
      </p>
    </div>
  );
}
