"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { isWalletAuthUser } from "@/lib/wallets/link";
import PracticeBadge from "@/components/practice-badge";

type DashboardStats = {
  points: number;
  predictions: number;
  correct: number;
  streak: number;
  walletLinked: boolean;
  practiceMode: boolean;
  funded: boolean;
};

type DashboardStatus = "loading" | "error" | "ready";

const QUICK_LINKS = [
  { href: "/competitions", label: "Competitions" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/predictions", label: "My Predictions" },
  { href: "/models", label: "Model Stats" },
  { href: "/results", label: "Results" },
  { href: "/profile", label: "Profile" },
];

function DashboardSkeleton() {
  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-4xl space-y-8" aria-busy="true">
        {/* Header */}
        <div className="space-y-2">
          <div className="h-7 w-40 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-4 w-64 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
        </div>

        {/* Quick stats: 4 tiles */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800"
            />
          ))}
        </div>

        {/* Active competitions box */}
        <div className="space-y-3">
          <div className="h-4 w-44 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-40 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
        </div>

        {/* Quick links */}
        <div className="space-y-3">
          <div className="h-4 w-32 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

async function fetchDashboardStats(): Promise<DashboardStats | null> {
  const supabase = getBrowserSupabase();

  // Client-side auth guard: this route sits behind the proxy + layout auth
  // gate, so we only defend the fetch. No server-only imports here.
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) {
    // Unauthenticated — caller keeps the skeleton up; the auth gate redirects.
    return null;
  }

  const [predictionsResult, scoresResult, walletResult, profileResult] =
    await Promise.all([
      // Total predictions under RLS (policies also scope to the caller; the
      // explicit eq() keeps the intent visible).
      supabase
        .from("predictions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id),
      // 1:1 profile score row; missing row means brand-new account (zeros).
      supabase
        .from("user_scores")
        .select("total_points, current_streak")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase.from("wallets").select("address").maybeSingle(),
      supabase
        .from("users")
        .select("practice_mode, funded")
        .eq("id", user.id)
        .maybeSingle(),
    ]);

  if (predictionsResult.error) throw predictionsResult.error;
  if (scoresResult.error) throw scoresResult.error;
  if (walletResult.error) throw walletResult.error;
  if (profileResult.error) throw profileResult.error;

  const score = scoresResult.data;
  const walletLinked = walletResult.data !== null || isWalletAuthUser(user);

  return {
    // TODO(F6): replace with server-authoritative points read
    points: score?.total_points ?? 0,
    predictions: predictionsResult.count ?? 0,
    // Correct picks are derived during settlement (F18); not yet queryable.
    correct: 0,
    streak: score?.current_streak ?? 0,
    walletLinked,
    // A linked Solana account is a funded account; practice is an explicit
    // opt-out, so it is possible to be funded and choosing paper trading.
    funded: profileResult.data?.funded ?? walletLinked,
    practiceMode: profileResult.data?.practice_mode === true,
  };
}

function DashboardContent() {
  const [status, setStatus] = useState<DashboardStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DashboardStats>({
    points: 0,
    predictions: 0,
    correct: 0,
    streak: 0,
    walletLinked: false,
    practiceMode: false,
    funded: false,
  });

  const load = useCallback(async () => {
    try {
      const next = await fetchDashboardStats();
      if (next === null) {
        // Unauthenticated: stay on the skeleton (auth gate handles redirect).
        return;
      }
      setStats(next);
      setStatus("ready");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load your dashboard. Please try again.",
      );
      setStatus("error");
    }
  }, []);

  // Every setState in load() runs after an await, so this is not the
  // synchronous-in-effect case the rule targets.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function retry() {
    setStatus("loading");
    setError(null);
    void load();
  }

  if (status === "loading") {
    return <DashboardSkeleton />;
  }

  if (status === "error") {
    return (
      <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-4xl space-y-4" role="alert">
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
            <p className="font-medium">Could not load your dashboard.</p>
            {error && <p className="mt-1 break-words">{error}</p>}
          </div>
          <button
            type="button"
            onClick={retry}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const tiles = [
    {
      label: "Points",
      value: stats.points,
      color: "text-zinc-900 dark:text-zinc-50",
    },
    {
      label: "Predictions",
      value: stats.predictions,
      color: "text-zinc-900 dark:text-zinc-50",
    },
    {
      label: "Correct",
      value: stats.correct,
      color: "text-green-600 dark:text-green-400",
    },
    {
      label: "Streak",
      value: stats.streak,
      color: "text-zinc-900 dark:text-zinc-50",
    },
  ];

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-4xl space-y-8">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Dashboard
            </h1>
            {stats.practiceMode && <PracticeBadge label="Practice" />}
            {!stats.funded && <PracticeBadge label="No wallet" />}
          </div>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Your prediction platform at a glance.
          </p>
        </div>

        {!stats.funded && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
            <span className="font-medium">No Solana account linked.</span> You
            can join and predict on rounds others create, but only funded
            accounts (those with a linked Solana wallet) can create rounds.{" "}
            <Link
              href="/link-wallet"
              className="font-medium underline underline-offset-4"
            >
              Link a wallet
            </Link>
          </div>
        )}

        {stats.funded && stats.practiceMode && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
            <span className="font-medium">Practice mode.</span> Your Solana
            account is linked, but you&apos;re playing with paper predictions —
            nothing is tracked beyond points.{" "}
            <Link
              href="/link-wallet"
              className="font-medium underline underline-offset-4"
            >
              Switch to live
            </Link>
          </div>
        )}

        {/* Quick stats */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {tiles.map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {s.label}
              </p>
              <p className={`mt-1 text-2xl font-bold ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Active competitions */}
        <div>
          <h2 className="mb-3 text-base font-medium text-zinc-900 dark:text-zinc-50">
            Active Competitions
          </h2>
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No active competitions right now. Check back later or browse{" "}
              <Link
                href="/competitions"
                className="font-medium text-zinc-700 underline hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-50"
              >
                all competitions
              </Link>
              .
            </p>
            {stats.predictions === 0 && (
              <p className="mt-4">
                <Link
                  href="/competitions"
                  className="inline-flex rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  Place your first prediction
                </Link>
              </p>
            )}
          </div>
        </div>

        {/* Quick links */}
        <div>
          <h2 className="mb-3 text-base font-medium text-zinc-900 dark:text-zinc-50">
            Quick Links
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {QUICK_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-center text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return <DashboardContent />;
}
