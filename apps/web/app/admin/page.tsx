import { redirect } from "next/navigation";
import { connection } from "next/server";

import { CompetitionForm } from "@/app/admin/competition-form";
import { getAuthenticatedUser, getAdminDataClient } from "@/lib/server/auth";

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
  ]);

  if (challengeError || modelError) {
    const catalogError =
      challengeError?.message ?? modelError?.message ?? "Unknown catalog error";

    return (
      <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-3xl">
          <div className="rounded-xl border border-red-200 bg-red-50 p-6 dark:border-red-900 dark:bg-red-950/30">
            <h1 className="text-lg font-semibold text-red-800 dark:text-red-200">
              Competition catalog unavailable
            </h1>
            <p className="mt-2 text-sm text-red-700 dark:text-red-300">
              Supabase could not load the challenge or model catalog.
              {catalogError ? ` ${catalogError}` : ""}
            </p>
          </div>
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
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-3xl space-y-8">
        <div>
          <p className="text-sm font-medium text-zinc-500">Admin dashboard</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Create a competition
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Select a published challenge, participating models, and a deadline.
          </p>
        </div>
        {challengeOptions.length === 0 || modelOptions.length < 2 ? (
          <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-6 dark:border-amber-900 dark:bg-amber-950/20">
            <h2 className="font-medium text-amber-900 dark:text-amber-200">
              Catalog setup required
            </h2>
            <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
              {challengeOptions.length === 0 &&
                "Add at least one published challenge. "}
              {modelOptions.length < 2 && "Add at least two active AI models."}
            </p>
          </div>
        ) : (
          <CompetitionForm
            challenges={challengeOptions}
            models={modelOptions}
          />
        )}
      </div>
    </div>
  );
}
