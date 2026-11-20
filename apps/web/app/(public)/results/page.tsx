"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, PageHeader, Panel, Status } from "@/components/ui";
import type { ResultDisplayState } from "@ai-showdown/shared";

interface ResultEntry {
  round_id: string;
  slug: string;
  brief_title: string;
  kind: "settled" | "voided";
  display_state: ResultDisplayState;
  conformed_model: string | null;
  crowd_model: string | null;
  pool_sol: number;
  reason: string;
  settled_at: string;
}

/**
 * The results list (F19).
 *
 * Every settled or voided round, with its two independent outcomes kept apart:
 * which model conformed to the brief, and which one the crowd named best. Each
 * card leads to the full result — the three rendered artifacts, a replay of each
 * model's code, the judge's reasons and the final odds — at `/results/[id]`.
 *
 * Status is a dot plus a word, never amber (amber is account-warning only).
 */
export default function ResultsPage() {
  const [results, setResults] = useState<ResultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => {
    setLoading(true);
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    let active = true;

    fetch("/api/results", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error?.message ?? "Could not load results");
        }
        return body.results as ResultEntry[];
      })
      .then((loaded) => {
        if (!active) return;
        setResults(loaded);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load results",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  return (
    <div className="shell py-14 sm:py-16">
      <PageHeader
        title="Results"
        description="Every settled round keeps its two outcomes separate: which model conformed to the brief, and which one the crowd named best."
      />

      <div className="mt-10">
        {loading && results.length === 0 ? (
          <Panel quiet className="px-5 py-8 text-center" aria-busy="true">
            <p className="t-mono text-[0.625rem] text-faint">
              Loading results…
            </p>
          </Panel>
        ) : error ? (
          <div role="alert">
            <Panel quiet className="px-5 py-8 text-center">
              <Status tone="amber">Unavailable</Status>
              <p className="mt-3 text-[0.9375rem] text-ink">
                Results could not be loaded.
              </p>
              <p className="t-body mt-2 text-sm text-muted">{error}</p>
              <button
                type="button"
                onClick={reload}
                className="btn btn-ghost btn-sm mt-5"
              >
                Try again
              </button>
            </Panel>
          </div>
        ) : results.length === 0 ? (
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
                <Link
                  href={`/results/${r.round_id}`}
                  className="panel panel-interactive group block p-6"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <h2 className="t-title text-[1.0625rem] text-ink">
                        {r.brief_title}
                      </h2>
                      <Status tone={r.kind === "voided" ? "violet" : "ink"}>
                        {r.kind === "voided" ? "Void" : "Settled"}
                      </Status>
                    </div>
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

                  {r.reason ? (
                    <p className="t-body mt-4 text-xs text-muted">{r.reason}</p>
                  ) : null}

                  <p className="t-body mt-2 text-xs text-faint">
                    {r.kind === "voided"
                      ? "No winner. Every wager was refunded."
                      : `Pool split: ${r.pool_sol.toLocaleString(undefined, { maximumFractionDigits: 3 })} Devnet SOL, pro-rata among backers of the conforming model.`}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
