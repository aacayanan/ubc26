"use client";

import Link from "next/link";
import { EmptyState, PageHeader, Panel } from "@/components/ui";

interface ResultEntry {
  round_id: string;
  brief_title: string;
  conformed_model: string | null;
  crowd_model: string | null;
  pool_points: number;
  settled_at: string;
}

export default function ResultsPage() {
  // TODO: load from API — GET /api/results
  const results: ResultEntry[] = [];

  return (
    <div className="shell py-14 sm:py-16">
      <PageHeader
        title="Results"
        description="Every settled round keeps its two outcomes separate: which model conformed to the brief, and which one the crowd named best."
      />

      <div className="mt-10">
        {results.length === 0 ? (
          <EmptyState
            title="Nothing has settled yet."
            action={
              <Link href="/competitions" className="btn btn-ghost btn-sm">
                Browse rounds
              </Link>
            }
          >
            A round lands here once its renders are judged, the vote has closed
            and the pool has been split.
          </EmptyState>
        ) : (
          <ul className="grid gap-3">
            {results.map((r) => (
              <li key={r.round_id}>
                <Panel className="p-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <h2 className="t-title text-[1.0625rem] text-ink">
                      {r.brief_title}
                    </h2>
                    <span className="t-mono text-[0.625rem] text-faint">
                      {new Date(r.settled_at).toLocaleString()}
                    </span>
                  </div>

                  <div className="mt-5 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-2">
                    <div className="bg-void-2/80 px-5 py-4">
                      <p className="t-label text-[0.5625rem] text-faint">
                        Conformed
                      </p>
                      <p className="mt-1.5 text-[1rem] text-ink">
                        {r.conformed_model ?? "No model conformed"}
                      </p>
                    </div>
                    <div className="bg-void-2/80 px-5 py-4">
                      <p className="t-label text-[0.5625rem] text-faint">
                        Crowd&rsquo;s choice
                      </p>
                      <p className="mt-1.5 text-[1rem] text-ink">
                        {r.crowd_model ?? "—"}
                      </p>
                    </div>
                  </div>

                  <p className="t-body mt-4 text-xs text-faint">
                    Pool split: {r.pool_points.toLocaleString()} pts, pro-rata
                    among backers of the conforming model.
                  </p>
                </Panel>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
