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
import DisplayNameForm from "./display-name-form";

function ProfileUnavailable() {
  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-xl space-y-4" role="alert">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Profile
        </h1>
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
          <p className="font-medium">Your profile could not be loaded.</p>
          <p className="mt-1">
            You are signed in, but your account record is missing. Reload to
            retry the automatic repair, or sign out and back in.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg bg-zinc-50 p-3 text-center dark:bg-zinc-800/50">
      <p
        className={`text-2xl font-bold ${
          accent
            ? "text-green-600 dark:text-green-400"
            : "text-zinc-900 dark:text-zinc-50"
        }`}
      >
        {value}
      </p>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
    </div>
  );
}

export default async function ProfilePage() {
  const user = await requireUser();

  let profile: Profile;
  try {
    profile = await getOrRepairProfile(user);
  } catch (error) {
    if (error instanceof NotFoundError) {
      logger.error("profile.page.missing", {
        correlationId: getCorrelationId(),
        userId: user.id,
      });
      return <ProfileUnavailable />;
    }
    throw error;
  }

  const initials = (profile.displayName ?? user.email ?? profile.id)
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-xl">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Profile
        </h1>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-100 text-xl font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {initials}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                  {profile.displayName ?? "Anonymous"}
                </h2>
                {profile.practiceMode && <PracticeBadge label="Practice" />}
                {!profile.funded && <PracticeBadge label="No wallet" />}
              </div>
              <p className="truncate text-sm text-zinc-500 dark:text-zinc-400">
                {user.email ?? "Signed in with a Solana wallet"}
              </p>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Points" value={profile.points} />
            <Stat label="Predictions" value={profile.predictions} />
            <Stat label="Streak" value={profile.currentStreak} />
            <Stat label="Best Streak" value={profile.longestStreak} />
          </div>

          <DisplayNameForm initialValue={profile.displayName ?? ""} />
        </div>

        <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-50">
            Wallet
          </h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {profile.funded
              ? "A Solana wallet is linked to this account."
              : "Link a Solana wallet to join live rounds and verify prediction commitments on-chain."}
          </p>
          <Link
            href="/link-wallet"
            className="mt-3 inline-flex w-full items-center justify-center rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
          >
            {profile.funded ? "Manage wallet" : "Connect Solana wallet"}
          </Link>
        </div>
      </div>
    </div>
  );
}
