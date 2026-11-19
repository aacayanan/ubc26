import Link from "next/link";
import PracticeBadge from "@/components/practice-badge";
import { NotFoundError } from "@/lib/server/errors/app-error";
import { getCorrelationId } from "@/lib/server/http/api-error";
import { logger } from "@/lib/server/logging/logger";
import { requireUser } from "@/lib/server/services/auth/session";
import {
  getOrRepairProfile,
  type Profile,
} from "@/lib/server/services/profile/profile";

const QUICK_LINKS = [
  { href: "/competitions", label: "Competitions" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/predictions", label: "My Predictions" },
  { href: "/models", label: "Model Stats" },
  { href: "/results", label: "Results" },
  { href: "/profile", label: "Profile" },
];

function ProfileUnavailable() {
  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-4xl space-y-4" role="alert">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Dashboard
        </h1>
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
          <p className="font-medium">Your profile could not be loaded.</p>
          <p className="mt-1">
            You are signed in, but your account record is missing. Reload to
            retry the automatic repair, or sign out and back in.
          </p>
        </div>
        <div className="flex gap-3">
          <Link
            href="/dashboard"
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Reload
          </Link>
          <Link
            href="/profile"
            className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
          >
            Go to profile
          </Link>
        </div>
      </div>
    </div>
  );
}

function StatTiles({ profile }: { profile: Profile }) {
  const tiles = [
    {
      label: "Points",
      value: profile.points,
      color: "text-zinc-900 dark:text-zinc-50",
    },
    {
      label: "Predictions",
      value: profile.predictions,
      color: "text-zinc-900 dark:text-zinc-50",
    },
    {
      label: "Streak",
      value: profile.currentStreak,
      color: "text-zinc-900 dark:text-zinc-50",
    },
    {
      label: "Best Streak",
      value: profile.longestStreak,
      color: "text-zinc-900 dark:text-zinc-50",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {tiles.map((s) => (
        <div
          key={s.label}
          className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{s.label}</p>
          <p className={`mt-1 text-2xl font-bold ${s.color}`}>{s.value}</p>
        </div>
      ))}
    </div>
  );
}

export default async function DashboardPage() {
  const user = await requireUser();

  let profile: Profile;
  try {
    profile = await getOrRepairProfile(user);
  } catch (error) {
    if (error instanceof NotFoundError) {
      logger.error("dashboard.profile.missing", {
        correlationId: getCorrelationId(),
        userId: user.id,
      });
      return <ProfileUnavailable />;
    }
    throw error;
  }

  const greeting = profile.displayName ?? user.email?.split("@")[0] ?? "there";

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-4xl space-y-8">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Welcome back, {greeting}
            </h1>
            {profile.practiceMode && <PracticeBadge label="Practice" />}
            {!profile.funded && <PracticeBadge label="No wallet" />}
          </div>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Your prediction platform at a glance.
          </p>
        </div>

        {!profile.funded && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
            <span className="font-medium">No Solana account linked.</span> You
            can browse rounds and watch results, but joining a round needs a
            funded account (a linked Solana wallet).{" "}
            <Link
              href="/link-wallet"
              className="font-medium underline underline-offset-4"
            >
              Link a wallet
            </Link>
          </div>
        )}

        {profile.funded && profile.practiceMode && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
            <span className="font-medium">Practice mode.</span> Your Solana
            account is linked, but you&apos;re in paper mode — no prompt session
            starts when you join a round.{" "}
            <Link
              href="/link-wallet"
              className="font-medium underline underline-offset-4"
            >
              Switch to live
            </Link>
          </div>
        )}

        <StatTiles profile={profile} />

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
            <p className="mt-4">
              <Link
                href="/competitions"
                className="inline-flex rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Place your first prediction
              </Link>
            </p>
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
