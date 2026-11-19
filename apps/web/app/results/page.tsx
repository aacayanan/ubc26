"use client";

import { useEffect, useState } from "react";

interface ResultEntry {
  competition_id: string;
  competition_title: string;
  status: string;
  accuracy_winner: string | null;
  speed_winner: string | null;
  length_winner: string | null;
  settled_at: string;
}

export default function ResultsPage() {
  const [results, setResults] = useState<ResultEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // TODO: fetch from API — GET /api/results
    // const fetchResults = async () => {
    //   const res = await fetch("/api/results");
    //   const data = await res.json();
    //   setResults(data);
    // };
    // fetchResults();
    setLoading(false);
  }, []);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-zinc-500">Loading results…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-3xl">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Competition Results
        </h1>

        {results.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-6 py-12 text-center dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No results yet. Results will appear after each competition
              settles.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {results.map((r) => (
              <div
                key={r.competition_id}
                className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex items-start justify-between">
                  <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-50">
                    {r.competition_title}
                  </h2>
                  <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    Settled
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-lg bg-blue-50 px-3 py-2 dark:bg-blue-900/20">
                    <p className="text-xs text-blue-600 dark:text-blue-400">
                      Accuracy
                    </p>
                    <p className="mt-0.5 text-sm font-semibold text-blue-700 dark:text-blue-300">
                      {r.accuracy_winner || "—"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-green-50 px-3 py-2 dark:bg-green-900/20">
                    <p className="text-xs text-green-600 dark:text-green-400">
                      Speed
                    </p>
                    <p className="mt-0.5 text-sm font-semibold text-green-700 dark:text-green-300">
                      {r.speed_winner || "—"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-purple-50 px-3 py-2 dark:bg-purple-900/20">
                    <p className="text-xs text-purple-600 dark:text-purple-400">
                      Code Length
                    </p>
                    <p className="mt-0.5 text-sm font-semibold text-purple-700 dark:text-purple-300">
                      {r.length_winner || "—"}
                    </p>
                  </div>
                </div>

                <p className="mt-3 text-xs text-zinc-400">
                  Settled {new Date(r.settled_at).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
