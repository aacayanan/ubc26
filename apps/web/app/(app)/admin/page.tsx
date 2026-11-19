import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { PageHeader, Panel, SectionHeading, Status } from "@/components/ui";
import {
  getCurrentRole,
  getCurrentUser,
} from "@/lib/server/services/auth/session";
import { listPublishedBriefs } from "@/lib/server/services/briefs/briefs";
import { getActiveLineup } from "@/lib/server/services/llm/models";
import CompetitionForm from "./competition-form";

export const metadata: Metadata = { title: "Operator console" };

export default async function AdminPage() {
  await connection();
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  const role = await getCurrentRole();

  // Role is read from the profile row, so a signed-in non-admin never reaches
  // the catalog. The proxy gates the path; this gates the data.
  if (role !== "admin") {
    redirect("/dashboard");
  }

  let briefs: Awaited<ReturnType<typeof listPublishedBriefs>> = [];
  let models: Awaited<ReturnType<typeof getActiveLineup>> = [];
  let catalogError: string | null = null;

  try {
    [briefs, models] = await Promise.all([
      listPublishedBriefs(),
      getActiveLineup(),
    ]);
  } catch (error) {
    catalogError =
      error instanceof Error ? error.message : "Unknown catalog error";
  }

  const briefOptions = briefs.map((brief) => ({
    id: brief.id,
    name: brief.title,
    meta: `v${brief.version} · ${brief.slug}`,
  }));
  const modelOptions = models.map((model) => ({
    id: model.id,
    name: model.name,
    meta: model.provider,
  }));
  const ready =
    !catalogError && briefOptions.length > 0 && modelOptions.length >= 2;

  return (
    <div className="shell py-14 sm:py-16">
      <PageHeader
        title="Operator console"
        description="Open a round: pick a published brief, the models that will render it, and the moment staking closes. Nothing is visible to the crowd until the round is open."
      />

      <div className="mt-10 grid gap-3 lg:grid-cols-[1.15fr_1fr] lg:items-start">
        <section>
          <SectionHeading aside={<Status tone="violet">Admin</Status>}>
            New round
          </SectionHeading>

          <Panel className="mt-5 p-6 sm:p-7">
            {catalogError ? (
              <div role="alert">
                <Status tone="amber">Catalog unavailable</Status>
                <p className="t-title mt-4 text-lg text-ink">
                  The brief or model catalog could not be read.
                </p>
                <p className="t-body mt-2 max-w-[52ch] text-sm text-muted">
                  {catalogError}
                </p>
              </div>
            ) : ready ? (
              <CompetitionForm briefs={briefOptions} models={modelOptions} />
            ) : (
              <div>
                <Status tone="amber">Catalog setup required</Status>
                <p className="t-title mt-4 text-lg text-ink">
                  The lineup is not ready to open a round.
                </p>
                <ul className="t-body mt-3 space-y-1.5 text-sm text-muted">
                  {briefOptions.length === 0 ? (
                    <li>
                      No published brief exists. Seed and validate the brief
                      bank before opening a round.
                    </li>
                  ) : null}
                  {modelOptions.length < 2 ? (
                    <li>
                      Fewer than two active models. A round needs at least two
                      to be a showdown.
                    </li>
                  ) : null}
                </ul>
              </div>
            )}
          </Panel>
        </section>

        <section>
          <SectionHeading aside={<Status tone="idle">Read only</Status>}>
            Catalog
          </SectionHeading>

          <Panel quiet className="mt-5 p-6">
            <p className="t-label text-[0.5625rem] text-faint">
              Published briefs
            </p>
            {briefOptions.length === 0 ? (
              <p className="t-body mt-2.5 text-sm text-faint">
                None published.
              </p>
            ) : (
              <ul className="mt-3">
                {briefOptions.map((brief) => (
                  <li
                    key={brief.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-hairline py-2.5 first:pt-0 last:border-0 last:pb-0"
                  >
                    <span className="text-[0.875rem] text-ink">
                      {brief.name}
                    </span>
                    <span className="t-mono text-[0.625rem] text-faint">
                      {brief.meta}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <p className="t-label mt-6 text-[0.5625rem] text-faint">
              Active models
            </p>
            {modelOptions.length === 0 ? (
              <p className="t-body mt-2.5 text-sm text-faint">None active.</p>
            ) : (
              <ul className="mt-3">
                {modelOptions.map((model) => (
                  <li
                    key={model.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-hairline py-2.5 first:pt-0 last:border-0 last:pb-0"
                  >
                    <span className="text-[0.875rem] text-ink">
                      {model.name}
                    </span>
                    <span className="t-mono text-[0.625rem] text-faint">
                      {model.meta}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>
      </div>
    </div>
  );
}
