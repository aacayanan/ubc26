import type { Metadata } from "next";
import Link from "next/link";
import PracticeBadge from "@/components/practice-badge";
import {
  PageHeader,
  Panel,
  Readout,
  SectionHeading,
  Status,
} from "@/components/ui";
import { NotFoundError } from "@/lib/server/errors/app-error";
import { getCorrelationId } from "@/lib/server/http/api-error";
import { logger } from "@/lib/server/logging/logger";
import { requireUser } from "@/lib/server/services/auth/session";
import {
  getOrRepairProfile,
  type Profile,
} from "@/lib/server/services/profile/profile";
import DisplayNameForm from "./display-name-form";

export const metadata: Metadata = { title: "Profile" };

function ProfileUnavailable() {
  return (
    <div className="shell py-12 sm:py-14">
      <div className="max-w-xl" role="alert">
        <PageHeader title="Profile" />
        <Panel quiet className="mt-8 p-6">
          <Status tone="amber">Account record missing</Status>
          <p className="t-title mt-4 text-lg text-ink">
            Your profile could not be loaded.
          </p>
          <p className="t-body mt-2 text-sm text-muted">
            You are signed in, but your account record is missing. Reload to
            retry the automatic repair, or sign out and back in.
          </p>
          <Link href="/dashboard" className="btn btn-solid btn-sm mt-6">
            Back to dashboard
          </Link>
        </Panel>
      </div>
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
    <div className="shell py-12 sm:py-14">
      <div className="max-w-2xl space-y-8">
        <PageHeader title="Profile" />

        <Panel className="p-6 sm:p-7">
          <div className="flex items-center gap-4">
            <div className="grid size-14 shrink-0 place-items-center rounded-full border border-hairline bg-white/[0.05] text-lg font-medium text-ink">
              {initials}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-[1.0625rem] font-medium text-ink">
                  {profile.displayName ?? "Anonymous"}
                </h2>
                {!profile.funded ? (
                  <PracticeBadge label="No wallet" />
                ) : profile.practiceMode ? (
                  <PracticeBadge label="Practice" />
                ) : null}
              </div>
              <p className="mt-1 truncate text-sm text-muted">
                {user.email ?? "Signed in with a Solana wallet"}
              </p>
            </div>
          </div>

          <div className="mt-7 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-2">
            {[
              {
                label: "Correct predictions",
                value: profile.correctPredictions,
              },
              { label: "Predictions", value: profile.predictions },
            ].map((s) => (
              <div key={s.label} className="bg-[rgb(11_9_18/0.62)] px-4 py-4">
                <Readout label={s.label} value={s.value} />
              </div>
            ))}
          </div>

          <DisplayNameForm initialValue={profile.displayName ?? ""} />
        </Panel>

        <section>
          <SectionHeading
            aside={
              profile.funded ? (
                <Status tone="ink">Linked</Status>
              ) : (
                <Status tone="amber">Not linked</Status>
              )
            }
          >
            Wallet
          </SectionHeading>
          <Panel className="mt-4 p-6">
            <p className="t-body text-sm text-muted">
              {profile.funded
                ? "A Solana wallet is linked to this account. Stakes are sealed against it before every deadline."
                : "Link a Solana wallet to stake on live rounds and verify your prediction commitments on-chain. You can keep browsing and voting without one."}
            </p>
            <Link
              href="/link-wallet"
              className="btn btn-ghost btn-sm mt-5 inline-flex"
            >
              {profile.funded ? "Manage wallet" : "Link a wallet"}
            </Link>
          </Panel>
        </section>
      </div>
    </div>
  );
}
