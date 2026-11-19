"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  EmptyState,
  Meter,
  PageHeader,
  Panel,
  Status,
  roundLabel,
  roundTone,
} from "@/components/ui";

interface Round {
  id: string;
  brief_title: string;
  brief_preview: string;
  models: string[];
  deadline: string; // ISO datetime
  state: string;
  pool_points: number;
  pool_capacity: number;
}

export default function CompetitionsPage() {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/competitions", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error?.message ?? "Could not load rounds");
        }
        return body.competitions as Array<{
          id: string;
          title: string;
          challenge_preview: string;
          models: string[];
          deadline: string;
          status: string;
          potential_points: number;
        }>;
      })
      .then((competitions) => {
        if (!active) return;
        setRounds(
          competitions.map((competition) => ({
            id: competition.id,
            brief_title: competition.title,
            brief_preview: competition.challenge_preview,
            models: competition.models,
            deadline: competition.deadline,
            state: competition.status,
            pool_points: competition.potential_points,
            pool_capacity: competition.potential_points,
          })),
        );
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load rounds",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="shell py-14 sm:py-16">
      <PageHeader
        title="Rounds"
        description="Each round is one creative brief and three models rendering it side by side. Staking closes at the deadline — after that, the crowd watches and votes."
      />

      <div className="mt-10">
        {loading ? (
          <Panel quiet className="px-5 py-8 text-center" aria-busy="true">
            <p className="t-mono text-[0.625rem] text-faint">
              Loading open rounds…
            </p>
          </Panel>
        ) : error ? (
          <div role="alert">
            <Panel quiet className="px-5 py-8 text-center">
              <p className="text-[0.9375rem] text-ink">Rounds unavailable.</p>
              <p className="t-body mt-2 text-sm text-muted">{error}</p>
            </Panel>
          </div>
        ) : rounds.length === 0 ? (
          <EmptyState
            title="No round is open right now."
            action={
              <div className="flex flex-wrap justify-center gap-3">
                <Link href="/leaderboard" className="btn btn-ghost btn-sm">
                  Leaderboard
                </Link>
                <Link href="/models" className="btn btn-ghost btn-sm">
                  Models
                </Link>
              </div>
            }
          >
            Rounds are opened by the operator, not by users. This page fills the
            moment the next brief is published — follow the leaderboard in the
            meantime.
          </EmptyState>
        ) : (
          <ul className="grid gap-3">
            {rounds.map((round) => (
              <li key={round.id}>
                <Link
                  href={`/competitions/${round.id}`}
                  className="panel panel-interactive group block p-6"
                >
                  <div className="flex flex-wrap items-start justify-between gap-6">
                    <div className="min-w-0 flex-1">
                      <Status
                        tone={roundTone(round.state)}
                        pulse={round.state === "OPEN"}
                      >
                        {roundLabel(round.state)}
                      </Status>
                      <h2 className="t-title mt-3 text-[1.0625rem] text-ink">
                        {round.brief_title}
                      </h2>
                      <p className="t-body mt-2 line-clamp-2 max-w-[62ch] text-sm text-muted">
                        {round.brief_preview}
                      </p>
                      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5">
                        <span className="t-mono text-[0.6875rem] text-faint">
                          {round.models.join(" · ")}
                        </span>
                        <span className="t-mono text-[0.6875rem] text-faint">
                          {new Date(round.deadline).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    <div className="w-28 shrink-0 text-right">
                      <p className="t-label text-[0.5625rem] text-faint">
                        Pool
                      </p>
                      <p className="t-num mt-1 text-[1.125rem] text-ink">
                        {round.pool_points.toLocaleString()}
                      </p>
                      <Meter
                        value={
                          round.pool_points / Math.max(round.pool_capacity, 1)
                        }
                        className="mt-2"
                        label={`Pool for ${round.brief_title} is ${Math.round((round.pool_points / Math.max(round.pool_capacity, 1)) * 100)} percent of capacity`}
                      />
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Panel
        quiet
        className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4"
      >
        <Status tone="live" pulse>
          Staking
        </Status>
        <p className="t-body text-[0.8125rem] text-muted">
          Open rounds accept stakes until the deadline.
        </p>
        <Status tone="violet">Locked</Status>
        <p className="t-body text-[0.8125rem] text-muted">
          Locked rounds are rendering, being judged, or settled.
        </p>
      </Panel>
    </div>
  );
}
