"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CountdownReadout } from "@/components/countdown";
import { EmptyState, Meter, PageHeader, Panel, Status } from "@/components/ui";
import { formatMultiplier } from "@/lib/odds";

interface OpenRound {
  id: string;
  title: string;
  preview: string;
  models: string[];
  deadline: string;
  pot: number;
  capacity: number;
  odds: Array<{
    modelId: string;
    modelName: string;
    staked: number;
    multiplier: number | null;
    share: number;
  }>;
}

/** One round on the list: preview, contenders, countdown, pool and odds. */
function RoundCard({
  round,
  onExpire,
}: {
  round: OpenRound;
  onExpire: () => void;
}) {
  const poolUsed = round.pot / Math.max(round.capacity, 1);
  const backed = round.odds.filter((model) => model.staked > 0);

  return (
    <Link
      href={`/competitions/${round.id}`}
      className="panel panel-interactive group block p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Status tone="live" pulse>
              Staking open
            </Status>
            <span className="t-mono flex items-center gap-1.5 text-[0.6875rem] text-muted">
              <span className="text-faint">closes in</span>
              <CountdownReadout
                deadline={round.deadline}
                onExpire={onExpire}
                className="t-num text-ink"
              />
            </span>
          </div>

          <h2 className="t-title mt-3 text-[1.0625rem] text-ink">
            {round.title}
          </h2>
          <p className="t-body mt-2 line-clamp-2 max-w-[62ch] text-sm text-muted">
            {round.preview}
          </p>
          <p className="t-mono mt-3 text-[0.6875rem] text-faint">
            {round.models.join(" · ")}
          </p>
        </div>

        <div className="w-40 shrink-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="t-label text-[0.5625rem] text-faint">Pool</span>
            <span className="t-num text-[1.125rem] text-ink">
              {round.pot.toLocaleString()}
            </span>
          </div>
          <Meter
            value={poolUsed}
            className="mt-2"
            label={`Pool is ${Math.round(poolUsed * 100)} percent of capacity`}
          />
          <p className="t-mono mt-2 text-[0.5625rem] leading-relaxed text-faint">
            {round.pot > 0 ? "multiplier if it wins" : "no stakes yet"}
          </p>
        </div>
      </div>

      {/* Odds: the pool split, per model. Never derived from renders. */}
      <ul className="mt-5 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-3">
        {round.odds.map((model) => (
          <li key={model.modelId} className="bg-void-2/80 px-4 py-3">
            <p className="truncate text-[0.8125rem] text-ink">
              {model.modelName}
            </p>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="t-mono text-[0.625rem] text-faint">
                {model.staked.toLocaleString()} pts
              </span>
              <span
                className={
                  model.multiplier === null
                    ? "t-num text-[0.8125rem] text-faint"
                    : "t-num text-[0.8125rem] text-ink"
                }
              >
                {formatMultiplier(model.multiplier)}
              </span>
            </div>
            {/* Share of the pot — the same datum as the multiplier, made visual. */}
            <Meter
              value={model.share}
              className="mt-2"
              label={`${model.modelName} holds ${Math.round(model.share * 100)} percent of the pool`}
            />
          </li>
        ))}
      </ul>

      {backed.length > 0 && backed.length < round.odds.length ? (
        <p className="t-mono mt-3 text-[0.5625rem] text-faint">
          unbacked models show no multiplier — nobody is in that pool
        </p>
      ) : null}
    </Link>
  );
}

export default function CompetitionsPage() {
  const [rounds, setRounds] = useState<OpenRound[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // `reload` is what sets the busy flag — an event, not an effect body. The
  // fetch effect below stays a pure "read into state" and does not cascade a
  // render before its own request starts.
  const reload = useCallback(() => {
    setLoading(true);
    setReloadKey((key) => key + 1);
  }, []);

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
          potential_points: number;
          pool_capacity: number;
          odds: Array<{
            model_id: string;
            model_name: string;
            staked: number;
            multiplier: number | null;
            share: number;
          }>;
        }>;
      })
      .then((competitions) => {
        if (!active) return;
        setRounds(
          competitions.map((competition) => ({
            id: competition.id,
            title: competition.title,
            preview: competition.challenge_preview,
            models: competition.models,
            deadline: competition.deadline,
            pot: competition.potential_points,
            capacity: competition.pool_capacity,
            odds: (competition.odds ?? []).map((model) => ({
              modelId: model.model_id,
              modelName: model.model_name,
              staked: model.staked,
              multiplier: model.multiplier,
              share: model.share,
            })),
          })),
        );
        setError(null);
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
  }, [reloadKey]);

  return (
    <div className="shell py-14 sm:py-16">
      <PageHeader
        title="Rounds"
        description="Each round is one creative brief and three models rendering it side by side. Staking closes at the deadline — after that, the crowd watches and votes."
      />

      <div className="mt-10">
        {loading && rounds.length === 0 ? (
          <Panel quiet className="px-5 py-8 text-center" aria-busy="true">
            <p className="t-mono text-[0.625rem] text-faint">
              Loading open rounds…
            </p>
          </Panel>
        ) : error ? (
          <div role="alert">
            <Panel quiet className="px-5 py-8 text-center">
              <Status tone="amber">Unavailable</Status>
              <p className="mt-3 text-[0.9375rem] text-ink">
                Rounds could not be loaded.
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
        ) : rounds.length === 0 ? (
          <EmptyState
            title="No round is open right now."
            action={
              <div className="flex flex-wrap justify-center gap-3">
                <button
                  type="button"
                  onClick={reload}
                  className="btn btn-ghost btn-sm"
                >
                  Refresh
                </button>
                <Link href="/leaderboard" className="btn btn-ghost btn-sm">
                  Leaderboard
                </Link>
              </div>
            }
          >
            Rounds are opened by the operator, not by users. This page fills the
            moment the next brief is published.
          </EmptyState>
        ) : (
          <ul className="grid gap-3">
            {rounds.map((round) => (
              <li key={round.id}>
                <RoundCard round={round} onExpire={reload} />
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
          Open rounds accept stakes until the deadline. The multiplier moves
          only as other people stake.
        </p>
        <Status tone="violet">Locked</Status>
        <p className="t-body text-[0.8125rem] text-muted">
          Locked rounds are rendering, being judged, or settled.
        </p>
      </Panel>
    </div>
  );
}
