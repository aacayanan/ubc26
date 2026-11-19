import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { getAuthenticatedUser } from "@/lib/server/auth";
import { getActiveCompetitions } from "@/lib/server/services/competitions/active-competitions";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  await connection();
  const user = await getAuthenticatedUser();

  if (!user) {
    redirect("/login");
  }

  if (user.role === "admin") {
    redirect("/admin");
  }

  const supabase = await createSupabaseServerClient();
  const competitions = await getActiveCompetitions(supabase);

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-4xl space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Your prediction platform at a glance.
          </p>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            {
              label: "Points",
              value: "0",
              color: "text-zinc-900 dark:text-zinc-50",
            },
            {
              label: "Predictions",
              value: "0",
              color: "text-zinc-900 dark:text-zinc-50",
            },
            {
              label: "Correct",
              value: "0",
              color: "text-green-600 dark:text-green-400",
            },
            {
              label: "Streak",
              value: "0",
              color: "text-zinc-900 dark:text-zinc-50",
            },
          ].map((s) => (
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
          {competitions.length === 0 ? (
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
            </div>
          ) : (
            <div className="space-y-3">
              {competitions.map((competition) => (
                <Link
                  key={competition.id}
                  href={`/competitions/${competition.id}`}
                  className="block rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-zinc-900 dark:text-zinc-50">
                        {competition.title}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {competition.models.map((model) => (
                          <span
                            key={model}
                            className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                          >
                            {model}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-zinc-400">
                      {new Date(competition.deadline).toLocaleDateString()}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Quick links */}
        <div>
          <h2 className="mb-3 text-base font-medium text-zinc-900 dark:text-zinc-50">
            Quick Links
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              { href: "/competitions", label: "Competitions" },
              { href: "/leaderboard", label: "Leaderboard" },
              { href: "/predictions", label: "My Predictions" },
              { href: "/models", label: "Model Stats" },
              { href: "/results", label: "Results" },
              { href: "/profile", label: "Profile" },
            ].map((link) => (
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
