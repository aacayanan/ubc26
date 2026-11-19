"use client";

import Link from "next/link";
import { EmptyState, PageHeader, Panel, Status } from "@/components/ui";

interface StakeRecord {
  id: string;
  round_id: string;
  brief_title: string;
  picked_model: string;
  points: number;
  outcome: "won" | "lost" | "void" | null;
  created_at: string;
}

export default function PredictionsPage() {
  // TODO: load from API — GET /api/stakes?user_id=...
  const stakes: StakeRecord[] = [];

  return (
    <div className="shell py-12 sm:py-14">
      <PageHeader
        title="My predictions"
        description="Every stake you have placed and what it returned. A stake resolves when the round settles — the points pool splits pro-rata among everyone who staked on the model that conformed."
      />

      <div className="mt-10">
        {stakes.length === 0 ? (
          <EmptyState
            title="You haven't staked on a round yet."
            action={
              <Link href="/competitions" className="btn btn-ghost btn-sm">
                Browse rounds
              </Link>
            }
          >
            Join an open round and stake points on the model you think follows
            the brief. Your commitment is sealed before anything renders.
          </EmptyState>
        ) : (
          <ul className="grid gap-3">
            {stakes.map((stake) => (
              <li key={stake.id}>
                <Link
                  href={`/competitions/${stake.round_id}`}
                  className="panel panel-interactive block p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[0.9375rem] text-ink">
                        {stake.brief_title}
                      </p>
                      <p className="t-mono mt-1 text-[0.6875rem] text-faint">
                        {stake.picked_model} · {stake.points} pts ·{" "}
                        {new Date(stake.created_at).toLocaleDateString()}
                      </p>
                    </div>

                    <div className="shrink-0">
                      {stake.outcome === "won" ? (
                        <Status tone="live">Won</Status>
                      ) : stake.outcome === "lost" ? (
                        <Status tone="idle">Lost</Status>
                      ) : stake.outcome === "void" ? (
                        <Status tone="amber">Void</Status>
                      ) : (
                        <Status tone="violet">Awaiting settle</Status>
                      )}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Panel quiet className="mt-8 px-5 py-4">
        <p className="t-body text-xs text-faint">
          Points only. Stakes never convert to money and are never transferable.
        </p>
      </Panel>
    </div>
  );
}
