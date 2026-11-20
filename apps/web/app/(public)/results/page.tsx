"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "@/components/icons";
import {
  EmptyState,
  PageHeader,
  Panel,
  RoundHash,
  Status,
} from "@/components/ui";
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
 * row leads to the full result — the three rendered artifacts, a replay of each
 * model's code, the judge's reasons and the final odds — at `/results/[id]`,
 * where the outcome reason and pool note live.
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
      <PageHeader title="Results" />

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
          /* One instrument table, not a stack of cards: a single glass panel
             with hairline-separated rows. Labels sit inline in every row, so
             the list reads the same whether scanned as a table or read a row
             at a time. */
          <Panel className="overflow-hidden" interactive>
            <ul>
              {results.map((r) => (
                <li
                  key={r.round_id}
                  className="border-t border-hairline first:border-t-0"
                >
                  {/* Base: three stacked lines — round, outcomes, pool+date.
                      lg: one aligned row of five columns. Pool and date share
                      a line below lg and split into their own columns above
                      it, handed straight to the row grid by `contents`. */}
                  <Link
                    href={`/results/${r.round_id}`}
                    className="group grid grid-cols-[1fr_auto] gap-x-5 gap-y-2.5 px-5 py-3.5 transition-colors hover:bg-white/[0.02] lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_8.5rem_9rem_1rem]"
                  >
                    {/* The brief names the round; the id is the handle that
                        names this instance and no other. */}
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-3">
                        <h2 className="t-title min-w-0 truncate text-[0.9375rem] text-ink">
                          {r.brief_title}
                        </h2>
                        <Status tone={r.kind === "voided" ? "violet" : "ink"}>
                          {r.kind === "voided" ? "Void" : "Settled"}
                        </Status>
                      </div>
                      <div className="mt-1">
                        <RoundHash id={r.round_id} />
                      </div>
                    </div>

                    {/* The two outcomes stay separate, never merged into one
                        "winner": the pool settles on conformance, the crowd
                        vote is its own award. */}
                    <div className="col-span-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 lg:col-span-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="t-label text-[0.5625rem] text-faint">
                          Conformed
                        </span>
                        <span className="text-[0.8125rem] text-ink">
                          {r.conformed_model ?? "No model conformed"}
                        </span>
                      </span>
                      <span className="flex items-baseline gap-1.5">
                        <span className="t-label text-[0.5625rem] text-faint">
                          Crowd&rsquo;s choice
                        </span>
                        <span className="text-[0.8125rem] text-ink">
                          {r.crowd_model ?? "—"}
                        </span>
                      </span>
                    </div>

                    <div className="col-span-2 flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 lg:contents">
                      {/* The number the eye compares down the column. On a
                          void the status says nothing moved; this is the pot
                          that was staked and returned. */}
                      <span className="flex items-baseline gap-1.5 lg:col-start-3 lg:row-start-1 lg:justify-end">
                        <span className="t-label text-[0.5625rem] text-faint">
                          Pool
                        </span>
                        <span className="t-num text-[0.8125rem] text-ink">
                          {r.pool_sol.toLocaleString(undefined, {
                            maximumFractionDigits: 3,
                          })}
                          <span className="ml-1 text-[0.625rem] text-faint">
                            SOL
                          </span>
                        </span>
                      </span>

                      {/* Settled date, faint mono; the full timestamp stays
                          on the title so the row shows only the date. */}
                      <span
                        className="t-mono whitespace-nowrap text-[0.625rem] text-faint lg:col-start-4 lg:row-start-1 lg:text-right"
                        title={new Date(r.settled_at).toLocaleString()}
                      >
                        {new Date(r.settled_at).toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </div>

                    <ChevronRight className="col-start-2 row-start-1 size-4 shrink-0 self-center justify-self-end text-faint transition-colors group-hover:text-muted lg:col-start-5 lg:row-start-1" />
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}
