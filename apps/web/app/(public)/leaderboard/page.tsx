"use client";

interface LeaderboardEntry {
  user_id: string;
  username: string;
  display_name: string;
  total_points: number;
  correct_predictions: number;
  streak: number;
}

export default function LeaderboardPage() {
  // TODO: load from API — GET /api/leaderboard
  const leaderboard: LeaderboardEntry[] = [];

  const medals = ["🥇", "🥈", "🥉"];

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-2xl">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Leaderboard
        </h1>

        {leaderboard.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-6 py-12 text-center dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No leaderboard data yet. Competitions must settle to populate
              rankings.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-400">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3 text-right">Points</th>
                  <th className="px-4 py-3 text-right">Correct</th>
                  <th className="px-4 py-3 text-right">Streak</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((entry, idx) => (
                  <tr
                    key={entry.user_id}
                    className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30"
                  >
                    <td className="px-4 py-3 text-zinc-400">
                      {idx < 3 ? medals[idx] : idx + 1}
                    </td>
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                      {entry.display_name || entry.username}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-medium text-zinc-700 dark:text-zinc-300">
                      {entry.total_points}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-500 dark:text-zinc-400">
                      {entry.correct_predictions}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-500 dark:text-zinc-400">
                      {entry.streak}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
