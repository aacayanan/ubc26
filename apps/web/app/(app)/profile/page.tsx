"use client";

import Link from "next/link";

export default function ProfilePage() {
  // TODO: load from API — GET /api/user/profile
  const user = null as {
    id: string;
    email: string;
    display_name: string;
    total_points: number;
    correct_predictions: number;
    streak: number;
    rounds_played: number;
  } | null;

  if (!user) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-zinc-500">
          Not logged in.{" "}
          <Link
            href="/login"
            className="font-medium text-zinc-700 underline dark:text-zinc-300"
          >
            Sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-xl">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Profile
        </h1>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-100 text-xl font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {user.display_name
                ? user.display_name.slice(0, 2).toUpperCase()
                : user.id.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                {user.display_name || "Anonymous"}
              </h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {user.email}
              </p>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-lg bg-zinc-50 p-3 text-center dark:bg-zinc-800/50">
              <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                {user.total_points}
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Points</p>
            </div>
            <div className="rounded-lg bg-zinc-50 p-3 text-center dark:bg-zinc-800/50">
              <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                {user.correct_predictions}
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Correct
              </p>
            </div>
            <div className="rounded-lg bg-zinc-50 p-3 text-center dark:bg-zinc-800/50">
              <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                {user.streak}
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Streak</p>
            </div>
            <div className="rounded-lg bg-zinc-50 p-3 text-center dark:bg-zinc-800/50">
              <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                {user.rounds_played}
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Rounds</p>
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-50">
            Wallet
          </h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Link a Solana wallet to verify prediction commitments on-chain.
          </p>
          <button
            type="button"
            disabled
            className="mt-3 w-full rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-500 shadow-sm cursor-not-allowed dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500"
          >
            Connect Wallet — Coming Soon (M5)
          </button>
        </div>
      </div>
    </div>
  );
}
