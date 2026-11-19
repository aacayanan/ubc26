import { redirect } from "next/navigation";
import { connection } from "next/server";

import { CompetitionForm } from "@/app/admin/competition-form";
import { getAuthenticatedUser, getAdminDataClient } from "@/lib/server/auth";
import {
  PageHeader,
  Panel,
  SectionHeading,
  Status,
  roundLabel,
  roundTone,
} from "@/components/ui";

export default async function AdminPage() {
  await connection();
  const user = await getAuthenticatedUser();

  if (!user) {
    redirect("/login");
  }

  if (user.role !== "admin") {
    redirect("/dashboard");
  }

  const supabase = await getAdminDataClient();
  const [
    { data: challenges, error: challengeError },
    { data: models, error: modelError },
    { data: rounds, error: roundError },
  ] = await Promise.all([
    supabase
      .from("challenges")
      .select("id, title")
      .eq("status", "published")
      .order("title"),
    supabase
      .from("llm_models")
      .select("id, name")
      .eq("is_active", true)
      .order("sort_order"),
    supabase
      .from("rounds")
      .select(
        "id, slug, status, prediction_deadline, challenges(title), round_models(llm_models(name))",
      )
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  if (challengeError || modelError || roundError) {
    const catalogError =
      challengeError?.message ??
      modelError?.message ??
      roundError?.message ??
      "Unknown catalog error";

    return (
      <div className="shell py-14 sm:py-16">
        <div role="alert">
          <Panel quiet className="p-6">
            <Status tone="amber">Competition catalog unavailable</Status>
            <p className="t-body mt-3 text-sm text-muted">
              Supabase could not load the challenge, model, or round catalog.
              {catalogError ? ` ${catalogError}` : ""}
            </p>
          </Panel>
        </div>
      </div>
    );
  }

  const challengeOptions = (challenges ?? []).map((challenge) => ({
    id: challenge.id,
    name: challenge.title,
  }));
  const modelOptions = (models ?? []).map((model) => ({
    id: model.id,
    name: model.name,
  }));

  return (
    <div className="shell py-12 sm:py-14">
      <div className="space-y-10">
        <PageHeader
          title="Admin Dashboard"
          description="Create a competition by pairing a published challenge with the participating models and a prediction deadline."
        />
        {challengeOptions.length === 0 || modelOptions.length < 2 ? (
          <Panel quiet className="p-6">
            <Status tone="amber">Catalog setup required</Status>
            <p className="t-body mt-3 text-sm text-muted">
              {challengeOptions.length === 0 &&
                "Add at least one published challenge. "}
              {modelOptions.length < 2 && "Add at least two active AI models."}
            </p>
          </Panel>
        ) : (
          <section>
            <SectionHeading>Create New Game</SectionHeading>
            <div className="mt-4">
              <CompetitionForm
                challenges={challengeOptions}
                models={modelOptions}
              />
            </div>
          </section>
        )}

        <section>
          <SectionHeading>Recent Games</SectionHeading>
          <div className="mt-4">
            {(rounds ?? []).length === 0 ? (
              <Panel quiet className="px-5 py-8 text-center">
                <p className="text-[0.9375rem] text-ink">
                  No games created yet.
                </p>
                <p className="t-body mt-2 text-sm text-muted">
                  Newly created rounds will appear here with their models and
                  lifecycle status.
                </p>
              </Panel>
            ) : (
              <Panel className="overflow-hidden">
                <ul>
                  {(rounds ?? []).map((round) => {
                    const challenge = Array.isArray(round.challenges)
                      ? round.challenges[0]
                      : round.challenges;
                    const modelsInRound = (round.round_models ?? [])
                      .flatMap((roundModel) =>
                        Array.isArray(roundModel.llm_models)
                          ? roundModel.llm_models
                          : [roundModel.llm_models],
                      )
                      .map((model) => model?.name)
                      .filter((name): name is string => Boolean(name));

                    return (
                      <li
                        key={round.id}
                        className="grid gap-4 border-b border-hairline px-5 py-5 last:border-0 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.7fr)_auto]"
                      >
                        <div>
                          <p className="text-[0.9375rem] text-ink">
                            {round.slug}
                          </p>
                          <p className="t-mono mt-1 text-[0.625rem] text-faint">
                            {challenge?.title ?? "Challenge"}
                          </p>
                        </div>
                        <div>
                          <p className="t-mono text-[0.625rem] text-faint">
                            {modelsInRound.join(" · ") || "No models"}
                          </p>
                          <p className="t-mono mt-1 text-[0.625rem] text-faint">
                            {new Date(
                              round.prediction_deadline,
                            ).toLocaleString()}
                          </p>
                        </div>
                        <Status tone={roundTone(round.status)}>
                          {roundLabel(round.status)}
                        </Status>
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
