"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Competition {
  id: string;
  title: string;
  challenge_preview: string;
  models: string[];
  deadline: string; // ISO datetime
  status: string;
  potential_points: number;
}

export default function CompetitionsPage() {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function fetchCompetitions() {
      try {
        const response = await fetch("/api/competitions");
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error?.message ?? "Could not load competitions");
        }
        if (active) {
          setCompetitions(body.competitions);
        }
      } catch (fetchError: unknown) {
        if (active) {
          setError(
            fetchError instanceof Error
              ? fetchError.message
              : "Could not load competitions",
          );
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void fetchCompetitions();
    return () => {
      active = false;
    };
  }, []);

  const statusColors: Record<string, string> = {
    OPEN: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
    LOCKED:
      "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400",
    RUNNING: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
    EVALUATING:
      "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400",
    SETTLED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    ARCHIVED:
      "bg-zinc-100 text-zinc-400 dark:bg-zinc-800/50 dark:text-zinc-500",
    CREATED: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-zinc-500">Loading competitions…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Competitions
          </h1>
        </div>

        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-6 py-12 text-center dark:border-red-900 dark:bg-red-950/30">
            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          </div>
        ) : competitions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-6 py-12 text-center dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No competitions available yet. Check back soon.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {competitions.map((comp) => (
              <Link
                key={comp.id}
                href={`/competitions/${comp.id}`}
                className="block rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-50">
                      {comp.title}
                    </h2>
                    <p className="mt-1 line-clamp-2 text-sm text-zinc-500 dark:text-zinc-400">
                      {comp.challenge_preview}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {comp.models.map((m) => (
                        <span
                          key={m}
                          className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2 text-right">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        statusColors[comp.status] || "bg-zinc-100 text-zinc-500"
                      }`}
                    >
                      {comp.status}
                    </span>
                    <span className="text-xs text-zinc-400">
                      {new Date(comp.deadline).toLocaleDateString()}
                    </span>
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
