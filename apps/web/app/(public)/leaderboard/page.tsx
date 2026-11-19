"use client";

import Link from "next/link";
import { EmptyState, PageHeader, Panel } from "@/components/ui";

interface LeaderboardEntry {
  user_id: string;
  username: string;
  display_name: string;
  total_points: number;
  correct_predictions: number;
  streak: number;
}

const rankTone = ["dot-live", "dot-violet", "dot-ink"];

export default function LeaderboardPage() {
  // TODO: load from API — GET /api/leaderboard
  const leaderboard: LeaderboardEntry[] = [];

  return (
    <div className="shell py-14 sm:py-16">
      <PageHeader
        title="Leaderboard"
        description="Points are awarded when a round settles — stake on the model that conforms to the brief and you take a share of the pool."
      />

      <div className="mt-10">
        {leaderboard.length === 0 ? (
          <EmptyState
            title="No one has scored yet."
            action={
              <Link href="/competitions" className="btn btn-ghost btn-sm">
                Browse open rounds
              </Link>
            }
          >
            Rankings populate the first time a round settles and its pool is
            split. Until then every account sits on zero.
          </EmptyState>
        ) : (
          <Panel className="overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline">
                  <th
                    scope="col"
                    className="t-label w-14 px-5 py-3.5 text-left text-[0.5625rem] font-normal text-faint"
                  >
                    #
                  </th>
                  <th
                    scope="col"
                    className="t-label px-5 py-3.5 text-left text-[0.5625rem] font-normal text-faint"
                  >
                    Account
                  </th>
                  <th
                    scope="col"
                    className="t-label px-5 py-3.5 text-right text-[0.5625rem] font-normal text-faint"
                  >
                    Points
                  </th>
                  <th
                    scope="col"
                    className="t-label hidden px-5 py-3.5 text-right text-[0.5625rem] font-normal text-faint sm:table-cell"
                  >
                    Conformed
                  </th>
                  <th
                    scope="col"
                    className="t-label hidden px-5 py-3.5 text-right text-[0.5625rem] font-normal text-faint sm:table-cell"
                  >
                    Streak
                  </th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((entry, idx) => (
                  <tr
                    key={entry.user_id}
                    className="border-b border-hairline transition-colors last:border-0 hover:bg-white/[0.025]"
                  >
                    <td className="px-5 py-4">
                      <span className="flex items-center gap-2.5">
                        <span
                          aria-hidden="true"
                          className={`dot ${rankTone[idx] ?? "dot-idle"}`}
                        />
                        <span className="t-num text-[0.75rem] text-faint">
                          {idx + 1}
                        </span>
                      </span>
                    </td>
                    <td className="px-5 py-4 text-ink">
                      {entry.display_name || entry.username}
                    </td>
                    <td className="t-num px-5 py-4 text-right text-ink">
                      {entry.total_points.toLocaleString()}
                    </td>
                    <td className="t-num hidden px-5 py-4 text-right text-muted sm:table-cell">
                      {entry.correct_predictions}
                    </td>
                    <td className="t-num hidden px-5 py-4 text-right text-muted sm:table-cell">
                      {entry.streak}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>
    </div>
  );
}
