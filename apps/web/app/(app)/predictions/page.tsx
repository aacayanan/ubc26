"use client";

import Link from "next/link";

interface PredictionRecord {
  id: string;
  competition_id: string;
  competition_title: string;
  category: string;
  picked_model: string;
  result: "correct" | "incorrect" | null;
  created_at: string;
}

export default function PredictionsPage() {
  // TODO: load from API — GET /api/predictions?user_id=...
  const predictions: PredictionRecord[] = [];

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-3xl">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          My Predictions
        </h1>

        {predictions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-6 py-12 text-center dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No predictions yet.{" "}
              <Link
                href="/competitions"
                className="font-medium text-zinc-700 underline hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-50"
              >
                Browse competitions
              </Link>{" "}
              to make your first pick.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {predictions.map((pred) => (
              <Link
                key={pred.id}
                href={`/competitions/${pred.competition_id}`}
                className="block rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                      {pred.competition_title}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {pred.category} · Picked{" "}
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        {pred.picked_model}
                      </span>
                    </p>
                  </div>
                  <div className="shrink-0">
                    {pred.result === "correct" ? (
                      <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-400">
                        ✓ Correct
                      </span>
                    ) : pred.result === "incorrect" ? (
                      <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">
                        ✗ Wrong
                      </span>
                    ) : (
                      <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        Pending
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
