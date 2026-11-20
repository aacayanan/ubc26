"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, PageHeader, Panel } from "@/components/ui";

interface LeaderboardEntry {
  key: string;
  rank: number;
  tied: boolean;
  display_name: string;
  pseudonymous: boolean;
  correct_predictions: number;
  decided_predictions: number;
  is_viewer: boolean;
  outside_top: boolean;
}

interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  total_ranked: number;
}

// Dot tone by rank (not row index), so accounts tied for a podium rank share it.
const rankTone: Record<number, string> = {
  1: "dot-live",
  2: "dot-violet",
  3: "dot-ink",
};

const headCell = "t-label px-5 py-3.5 text-[0.5625rem] font-normal text-faint";

export default function LeaderboardPage() {
  const [board, setBoard] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/leaderboard", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error?.message ?? "Could not load rankings");
        }
        return body as LeaderboardResponse;
      })
      .then((data) => {
        if (active) setBoard(data);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load rankings",
        );
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="shell py-14 sm:py-16">
      <PageHeader title="Leaderboard" />

      <div className="mt-10">
        {error ? (
          <div role="alert">
            <Panel quiet className="px-5 py-8 text-center">
              <p className="text-[0.9375rem] text-ink">Rankings unavailable.</p>
              <p className="t-body mt-2 text-sm text-muted">{error}</p>
            </Panel>
          </div>
        ) : !board ? (
          <Panel quiet className="px-5 py-8 text-center" aria-busy="true">
            <p className="t-mono text-[0.625rem] text-faint">
              Loading rankings…
            </p>
          </Panel>
        ) : board.entries.length === 0 ? (
          <EmptyState
            title="No prediction has settled yet."
            action={
              <Link href="/competitions" className="btn btn-ghost btn-sm">
                Browse open rounds
              </Link>
            }
          >
            Rankings populate the first time a round settles and its predictions
            are marked correct or incorrect.
          </EmptyState>
        ) : (
          <>
            <Panel className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Accounts ranked by correct predictions. Predictions counts
                  settled predictions. Accounts with equal correct predictions
                  share a rank.
                </caption>
                <thead>
                  <tr className="border-b border-hairline">
                    <th scope="col" className={`${headCell} w-16 text-left`}>
                      #
                    </th>
                    <th scope="col" className={`${headCell} text-left`}>
                      Account
                    </th>
                    <th scope="col" className={`${headCell} text-right`}>
                      Correct
                    </th>
                    <th
                      scope="col"
                      className={`${headCell} hidden text-right sm:table-cell`}
                    >
                      Predictions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {board.entries.map((entry) => (
                    <tr
                      key={entry.key}
                      aria-current={entry.is_viewer ? "true" : undefined}
                      className={`border-b border-hairline transition-colors last:border-0 hover:bg-white/[0.025] ${
                        entry.is_viewer ? "bg-white/[0.03]" : ""
                      } ${entry.outside_top ? "border-t border-dashed border-t-hairline-strong" : ""}`}
                    >
                      <td className="px-5 py-4">
                        <span className="flex items-center gap-2.5">
                          <span
                            aria-hidden="true"
                            className={`dot ${rankTone[entry.rank] ?? "dot-idle"}`}
                          />
                          <span className="t-num text-[0.75rem] text-faint">
                            {entry.tied ? (
                              <>
                                <span aria-hidden="true">=</span>
                                <span className="sr-only">Tied </span>
                              </>
                            ) : null}
                            {entry.rank}
                          </span>
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <span className="flex flex-wrap items-baseline gap-x-2.5">
                          <span
                            className={
                              entry.pseudonymous
                                ? "t-mono text-[0.75rem] text-muted"
                                : "text-ink"
                            }
                          >
                            {entry.display_name}
                          </span>
                          {entry.is_viewer ? (
                            <span className="t-label text-[0.5625rem] text-faint">
                              You
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="t-num px-5 py-4 text-right text-ink">
                        {entry.correct_predictions.toLocaleString()}
                      </td>
                      <td className="t-num hidden px-5 py-4 text-right text-muted sm:table-cell">
                        {entry.decided_predictions.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <div className="mt-4 flex flex-wrap justify-between gap-x-6 gap-y-2">
              <p className="t-mono text-[0.625rem] text-faint">
                Ranked by correct predictions. Equal counts share a rank (=).
                Refunded wagers do not count.
                {board.total_ranked > board.entries.length
                  ? ` Showing top of ${board.total_ranked.toLocaleString()} ranked accounts.`
                  : null}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
