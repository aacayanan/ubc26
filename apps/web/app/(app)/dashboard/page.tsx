import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "@/components/icons";
import { CountdownReadout } from "@/components/countdown";
import PracticeBadge from "@/components/practice-badge";
import {
  EmptyState,
  PageHeader,
  Panel,
  Readout,
  SectionHeading,
  Status,
} from "@/components/ui";
import { NotFoundError } from "@/lib/server/errors/app-error";
import { getCorrelationId } from "@/lib/server/http/api-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { logger } from "@/lib/server/logging/logger";
import { requireUser } from "@/lib/server/services/auth/session";
import {
  getActiveCompetitions,
  type ActiveCompetition,
} from "@/lib/server/services/competitions/active-competitions";
import {
  getOrRepairProfile,
  type Profile,
} from "@/lib/server/services/profile/profile";

export const metadata: Metadata = { title: "Dashboard" };

const QUICK_LINKS = [
  {
    href: "/competitions",
    label: "Open rounds",
    hint: "stake before the clock",
  },
  { href: "/predictions", label: "My predictions", hint: "sealed and settled" },
  { href: "/leaderboard", label: "Leaderboard", hint: "season standings" },
  { href: "/models", label: "Models", hint: "conformance by model" },
  { href: "/results", label: "Results", hint: "every settled round" },
  { href: "/profile", label: "Profile", hint: "identity and wallet" },
];

function ProfileUnavailable() {
  return (
    <div className="shell py-14 sm:py-16">
      <div className="max-w-2xl" role="alert">
        <PageHeader title="Dashboard" />
        <Panel quiet className="mt-8 p-6">
          <Status tone="amber">Account record missing</Status>
          <p className="t-title mt-4 text-lg text-ink">
            Your profile could not be loaded.
          </p>
          <p className="t-body mt-2 text-sm text-muted">
            You are signed in, but your account record is missing. Reload to
            retry the automatic repair, or sign out and back in.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/dashboard" className="btn btn-solid btn-sm">
              Reload
            </Link>
            <Link href="/profile" className="btn btn-ghost btn-sm">
              Go to profile
            </Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function InstrumentStrip({ profile }: { profile: Profile }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[18px] border border-hairline bg-hairline shadow-[0_28px_70px_-34px_rgb(0_0_0/0.95)] backdrop-blur-xl sm:grid-cols-4">
      {[
        { label: "Points", value: profile.points.toLocaleString() },
        { label: "Predictions", value: profile.predictions },
        { label: "Streak", value: profile.currentStreak },
        { label: "Best streak", value: profile.longestStreak },
      ].map((s) => (
        <div key={s.label} className="bg-[rgb(11_9_18/0.62)] px-5 py-5">
          <Readout label={s.label} value={s.value} />
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

  // F9: the dashboard's open-round list. A failure here must not take the whole
  // page down — the profile strip is still worth showing — so it degrades to an
  // empty list, which reads as "nothing open" rather than as an error.
  let openRounds: ActiveCompetition[] = [];
  try {
    openRounds = await getActiveCompetitions(getServiceRoleSupabase());
  } catch (error) {
    logger.error("dashboard.rounds.unavailable", {
      correlationId: getCorrelationId(),
      error,
    });
  }

  return (
    <div className="shell py-12 sm:py-14">
      <div className="space-y-10">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="t-title text-[clamp(1.7rem,3.2vw,2.25rem)] text-ink">
              Welcome back, {greeting}
            </h1>
            {!profile.funded ? (
              <PracticeBadge label="No wallet" />
            ) : profile.practiceMode ? (
              <PracticeBadge label="Practice" />
            ) : null}
          </div>
        </div>

        {!profile.funded ? (
          <Panel
            quiet
            className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4"
          >
            <Status tone="amber">No Solana account</Status>
            <p className="t-body flex-1 text-[0.8125rem] text-muted">
              You can browse rounds, watch renders and vote — staking on a live
              round needs a linked Solana wallet.
            </p>
            <Link href="/link-wallet" className="btn btn-ghost btn-sm">
              Link a wallet
            </Link>
          </Panel>
        ) : null}

        {profile.funded && profile.practiceMode ? (
          <Panel
            quiet
            className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4"
          >
            <Status tone="amber">Practice mode</Status>
            <p className="t-body flex-1 text-[0.8125rem] text-muted">
              Your wallet is linked, but you are in practice mode — you can
              browse, watch and vote, but no stake is placed.
            </p>
            <Link href="/link-wallet" className="btn btn-ghost btn-sm">
              Switch to live
            </Link>
          </Panel>
        ) : null}

        <InstrumentStrip profile={profile} />

        <section>
          <SectionHeading
            aside={
              <Link href="/results" className="link t-label text-[0.625rem]">
                All results
              </Link>
            }
          >
            Open rounds
          </SectionHeading>
          <div className="mt-4">
            {openRounds.length === 0 ? (
              <EmptyState
                title="No round is open right now."
                action={
                  <Link href="/competitions" className="btn btn-ghost btn-sm">
                    Browse rounds
                  </Link>
                }
              >
                Rounds are opened by the operator. When the next brief drops it
                appears here with its deadline and a live pool.
              </EmptyState>
            ) : (
              // F9: the dashboard is where open rounds are actionable, not just
              // a link to another page. Same deadline readout as the round list.
              <ul className="grid gap-3">
                {openRounds.map((round) => (
                  <li key={round.id}>
                    <Link
                      href={`/competitions/${round.id}`}
                      className="panel panel-interactive flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4"
                    >
                      <div className="min-w-0">
                        <p className="text-[0.9375rem] text-ink">
                          {round.title}
                        </p>
                        <p className="t-mono mt-1 text-[0.625rem] text-faint">
                          {round.models.join(" · ")}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-5">
                        <span className="t-mono text-[0.625rem] text-muted">
                          <span className="text-faint">closes in </span>
                          <CountdownReadout
                            deadline={round.deadline}
                            className="t-num text-ink"
                          />
                        </span>
                        <span className="t-num text-[0.875rem] text-ink">
                          {round.potentialPoints.toLocaleString()}
                          <span className="t-mono ml-1 text-[0.5625rem] text-faint">
                            pts pool
                          </span>
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section>
          <SectionHeading>Everything else</SectionHeading>
          <Panel className="mt-4 overflow-hidden">
            <ul className="grid sm:grid-cols-2">
              {QUICK_LINKS.map((link) => (
                <li
                  key={link.href}
                  className="border-b border-hairline last:border-0 sm:[&:nth-child(odd)]:border-r"
                >
                  <Link
                    href={link.href}
                    className="group flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-white/[0.03]"
                  >
                    <span className="min-w-0">
                      <span className="block text-[0.875rem] text-ink">
                        {link.label}
                      </span>
                      <span className="t-mono block text-[0.625rem] text-faint">
                        {link.hint}
                      </span>
                    </span>
                    <ArrowRight className="size-4 text-muted transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-ink" />
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      </div>
    </div>
  );
}
