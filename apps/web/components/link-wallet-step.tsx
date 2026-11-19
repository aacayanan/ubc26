"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Status } from "@/components/ui";
import {
  getLinkedWallet,
  getWalletAddress,
  isWalletAuthUser,
  linkWallet,
  setPracticeMode,
  type WalletLink,
} from "@/lib/wallets/link";
import { getBrowserSupabase } from "@/lib/supabase/browser";

type WalletState = "checking" | "unlinked" | "linked" | "error";

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
  const [status, setStatus] = useState<WalletState>("checking");
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
          err instanceof Error
            ? err.message
            : "Could not read your wallet status. Reload the page to try again.",
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
            ? "Wallet connection cancelled. Approve the request in Phantom and try again."
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
      setError(
        err instanceof Error
          ? err.message
          : "Could not link your wallet. Approve the request in Phantom and try again.",
      );
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
    <div className="flex min-h-[calc(100svh-64px)] items-center justify-center px-5 py-14">
      <div className="panel w-full max-w-[420px] p-8">
        <div>
          <h1 className="t-title text-[1.5rem] text-ink">
            Link your Solana wallet
          </h1>
          <p className="t-body mt-2.5 text-sm text-muted">
            Linking lets you stake on live rounds and verify your predictions
            on-chain. You can skip this and explore in practice mode first.
          </p>
        </div>

        {error ? (
          <p
            role="alert"
            className="mt-6 rounded-lg border border-magenta/30 bg-magenta/[0.07] px-3.5 py-2.5 text-[0.8125rem] text-magenta"
          >
            {error}
          </p>
        ) : null}

        {status === "checking" ? (
          <p className="t-mono mt-8 text-[0.6875rem] tracking-[0.14em] text-faint">
            CHECKING WALLET…
          </p>
        ) : null}

        {status === "linked" && wallet ? (
          <div className="mt-6 space-y-3">
            <div className="flex items-center gap-3 rounded-lg border border-hairline bg-white/[0.02] px-4 py-3">
              <Status tone="ink">Linked</Status>
              <span className="t-mono ml-auto text-[0.6875rem] text-muted">
                {wallet.address === walletPlaceholder.address
                  ? "wallet identity"
                  : shortAddress(wallet.address)}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void continueLive()}
              disabled={busy}
              className="btn btn-solid btn-block"
            >
              Continue
            </button>
            <button
              type="button"
              onClick={handleSkip}
              disabled={busy}
              className="btn btn-ghost btn-block"
            >
              Continue in practice mode
            </button>
          </div>
        ) : null}

        {status === "unlinked" || status === "error" ? (
          <div className="mt-6 space-y-3">
            <button
              type="button"
              onClick={() => void handleLink()}
              disabled={busy}
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
              {busy ? "Waiting for wallet…" : "Connect Solana wallet"}
            </button>
            {allowSkip ? (
              <button
                type="button"
                onClick={handleSkip}
                disabled={busy}
                className="btn btn-ghost btn-block"
              >
                Continue in practice mode
              </button>
            ) : null}
            <p className="t-body text-center text-xs text-faint">
              Practice accounts can browse rounds, watch renders and vote, but
              only a wallet-linked account can stake on a live round.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
