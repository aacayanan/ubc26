"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getLinkedWallet,
  getWalletAddress,
  isWalletAuthUser,
  linkWallet,
  setPracticeMode,
  type WalletLink,
} from "@/lib/wallets/link";
import { getBrowserSupabase } from "@/lib/supabase/browser";

type Status = "checking" | "unlinked" | "linked" | "error";

/** Stand-in for wallet sign-in users, whose address lives in their identity. */
const walletPlaceholder: WalletLink = { address: "wallet", verifiedAt: null };

export default function LinkWalletStep({
  redirectTo,
  allowSkip = true,
}: {
  redirectTo: string;
  allowSkip?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");
  const [wallet, setWallet] = useState<WalletLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const supabase = getBrowserSupabase();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          router.replace("/login");
          return;
        }

        const linked = await getLinkedWallet(supabase);
        if (cancelled) return;

        // Wallet sign-in users are already wallet-identified.
        const ready = isWalletAuthUser(user)
          ? (linked ?? walletPlaceholder)
          : linked;
        setWallet(ready);
        setStatus(ready ? "linked" : "unlinked");
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Could not check your wallet.",
        );
        setStatus("error");
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleLink() {
    setBusy(true);
    setError(null);
    try {
      const address = await getWalletAddress();
      if (!address) {
        throw new Error(
          window.solana
            ? "Wallet connection was cancelled."
            : "No Solana wallet found. Install Phantom, then reload this page.",
        );
      }

      const supabase = getBrowserSupabase();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Your session expired. Sign in again.");

      setWallet(await linkWallet(supabase, user, address));
      setStatus("linked");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link wallet.");
    } finally {
      setBusy(false);
    }
  }

  function handleSkip() {
    void skipToPractice();
  }

  function handleContinue() {
    router.push(redirectTo);
    router.refresh();
  }

  /** Leave practice mode too, so a previously-paper account can go live. */
  async function continueLive() {
    setBusy(true);
    try {
      const supabase = getBrowserSupabase();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) await setPracticeMode(supabase, user, false);
    } catch {
      // Non-fatal: the dashboard still works, just stays labelled practice.
    } finally {
      setBusy(false);
      handleContinue();
    }
  }

  async function skipToPractice() {
    setBusy(true);
    try {
      const supabase = getBrowserSupabase();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) await setPracticeMode(supabase, user, true);
    } catch {
      // Non-fatal: navigation still proceeds.
    } finally {
      setBusy(false);
      router.push(redirectTo);
      router.refresh();
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <div className="w-full max-w-md space-y-6 rounded-xl bg-white p-8 shadow-lg dark:bg-zinc-900">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Link your Solana wallet
          </h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            Linking lets you join live rounds and verify your predictions
            on-chain. You can skip this and explore in practice mode first.
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
            {error}
          </div>
        )}

        {status === "checking" && (
          <p className="text-center text-sm text-zinc-500">Checking…</p>
        )}

        {status === "linked" && wallet && (
          <div className="space-y-4">
            <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
              {wallet.address === walletPlaceholder.address
                ? "Signed in with your Solana wallet."
                : `Linked ${shortAddress(wallet.address)}`}
            </div>
            <button
              type="button"
              onClick={() => void continueLive()}
              className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Continue
            </button>
            <button
              type="button"
              onClick={handleSkip}
              className="w-full rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            >
              Use a practice account instead
            </button>
          </div>
        )}

        {(status === "unlinked" || status === "error") && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => void handleLink()}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              <span aria-hidden="true">◎</span>
              {busy ? "Waiting for wallet…" : "Connect Solana wallet"}
            </button>
            {allowSkip && (
              <button
                type="button"
                onClick={handleSkip}
                disabled={busy}
                className="w-full rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              >
                Skip for now — continue in practice mode
              </button>
            )}
            <p className="text-center text-xs text-zinc-400 dark:text-zinc-500">
              Practice accounts can browse rounds and watch results, but only a
              funded Solana account can join a live round.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
