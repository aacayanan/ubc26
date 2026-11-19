"use client";

import { useEffect, useState } from "react";

interface ModelStats {
  model_id: string;
  model_name: string;
  rounds_played: number;
  wins: number;
  losses: number;
  forfeits: number;
  accuracy_wins: number;
  speed_wins: number;
  length_wins: number;
  avg_execution_time_ms: number | null;
}

export default function ModelsPage() {
  const [models, setModels] = useState<ModelStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // TODO: fetch from API — GET /api/models
    // const fetchModels = async () => {
    //   const res = await fetch("/api/models");
    //   const data = await res.json();
    //   setModels(data);
    // };
    // fetchModels();
    setLoading(false);
  }, []);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-zinc-500">Loading models…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-4xl">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Model Performance
        </h1>
        <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
          Historical results across all settled competitions.
        </p>

        {models.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-6 py-12 text-center dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No performance data yet. Results will appear after the first
              competition settles.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {models.map((m) => (
              <div
                key={m.model_id}
                className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                    {m.model_name}
                  </h2>
                  <span className="text-xs text-zinc-400">
                    {m.rounds_played} rounds
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-zinc-400">Wins</span>
                    <p className="font-semibold text-green-600 dark:text-green-400">
                      {m.wins}
                    </p>
                  </div>
                  <div>
                    <span className="text-zinc-400">Losses</span>
                    <p className="font-semibold text-red-600 dark:text-red-400">
                      {m.losses}
                    </p>
                  </div>
                  <div>
                    <span className="text-zinc-400">Forfeits</span>
                    <p className="font-semibold text-yellow-600 dark:text-yellow-400">
                      {m.forfeits}
                    </p>
                  </div>
                  <div>
                    <span className="text-zinc-400">Win Rate</span>
                    <p className="font-semibold text-zinc-700 dark:text-zinc-300">
                      {m.rounds_played > 0
                        ? Math.round((m.wins / m.rounds_played) * 100)
                        : 0}
                      %
                    </p>
                  </div>
                </div>

                <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                  <p className="text-xs text-zinc-400">
                    Category wins — Accuracy:{" "}
                    <span className="font-medium text-zinc-600 dark:text-zinc-300">
                      {m.accuracy_wins}
                    </span>{" "}
                    · Speed:{" "}
                    <span className="font-medium text-zinc-600 dark:text-zinc-300">
                      {m.speed_wins}
                    </span>{" "}
                    · Length:{" "}
                    <span className="font-medium text-zinc-600 dark:text-zinc-300">
                      {m.length_wins}
                    </span>
                  </p>
                  {m.avg_execution_time_ms != null && (
                    <p className="mt-1 text-xs text-zinc-400">
                      Avg execution:{" "}
                      <span className="font-medium text-zinc-600 dark:text-zinc-300">
                        {(m.avg_execution_time_ms / 1000).toFixed(1)}s
                      </span>
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
