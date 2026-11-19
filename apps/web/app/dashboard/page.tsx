"use client";

export default function DashboardPage() {
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
            { label: "Points", value: "0", color: "text-zinc-900 dark:text-zinc-50" },
            { label: "Predictions", value: "0", color: "text-zinc-900 dark:text-zinc-50" },
            { label: "Correct", value: "0", color: "text-green-600 dark:text-green-400" },
            { label: "Streak", value: "0", color: "text-zinc-900 dark:text-zinc-50" },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {s.label}
              </p>
              <p className={`mt-1 text-2xl font-bold ${s.color}`}>
                {s.value}
              </p>
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
              <a
                href="/competitions"
                className="font-medium text-zinc-700 underline hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-50"
              >
                all competitions
              </a>
              .
            </p>
          </div>
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
              <a
                key={link.href}
                href={link.href}
                className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-center text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
