"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, PageHeader, Panel, Status } from "@/components/ui";

interface StakeRecord {
  id: string;
  roundId: string;
  briefTitle: string;
  pickedModel: string;
  points: number;
  awarded: number | null;
  outcome: "won" | "lost" | "void" | null;
  roundStatus: string;
  createdAt: string;
}

export default function PredictionsPage() {
  const [stakes, setStakes] = useState<StakeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/stakes", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error?.message ?? "Could not load your stakes");
        }
        return body.stakes as StakeRecord[];
      })
      .then((loaded) => {
        if (active) setStakes(loaded);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error ? loadError.message : "Load failed",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="shell py-12 sm:py-14">
      <PageHeader
        title="My predictions"
        description="Every stake you have placed and what it returned. A stake resolves when the round settles — the points pool splits pro-rata among everyone who staked on the model that conformed."
      />

      <div className="mt-10">
        {loading ? (
          <p className="t-label text-[0.625rem] text-faint">Loading…</p>
        ) : error ? (
          <Panel className="p-5">
            <p role="alert" className="text-sm text-magenta">
              {error}
            </p>
          </Panel>
        ) : stakes.length === 0 ? (
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
                  href={`/competitions/${stake.roundId}`}
                  className="panel panel-interactive block p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[0.9375rem] text-ink">
                        {stake.briefTitle}
                      </p>
                      <p className="t-mono mt-1 text-[0.6875rem] text-faint">
                        {stake.pickedModel} · {stake.points} pts ·{" "}
                        {new Date(stake.createdAt).toLocaleDateString()}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-3">
                      {stake.awarded !== null ? (
                        <span className="t-num text-[0.8125rem] text-muted">
                          {stake.awarded > 0 ? `+${stake.awarded}` : "0"} pts
                        </span>
                      ) : null}
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
