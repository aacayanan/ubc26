"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CountdownReadout } from "@/components/countdown";
import { modelInk } from "@/components/price-ribbon";
import {
  EmptyState,
  Meter,
  PageHeader,
  Panel,
  Status,
  roundLabel,
  roundTone,
} from "@/components/ui";
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

/** A round that is running or being judged right now (F27). */
interface LiveRound {
  id: string;
  title: string;
  status: string;
  models: string[];
  done: number;
  total: number;
}

/**
 * What is happening right now, above what is still open (F27).
 *
 * A running round used to be invisible unless you kept its URL — the list only
 * ever showed `OPEN`. This is the way back in. It renders nothing when no round
 * is live, so an idle arena is not padded with placeholders.
 */
function LiveStrip({ rounds }: { rounds: LiveRound[] }) {
  if (rounds.length === 0) return null;

  return (
    <section aria-labelledby="live-strip-heading" className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="live-strip-heading"
          className="t-title text-[1.0625rem] text-ink"
        >
          Live now
        </h2>
        <span className="t-mono text-[0.625rem] text-faint">
          watch it being written
        </span>
      </div>

      <ul className="mt-4 grid gap-3">
        {rounds.map((round) => (
          <li key={round.id}>
            <Link
              href={`/competitions/${round.id}`}
              className="panel panel-interactive flex flex-wrap items-center justify-between gap-x-8 gap-y-3 p-5"
            >
              <div className="min-w-0 flex-1">
                <Status
                  tone={roundTone(round.status)}
                  pulse={
                    round.status === "RUNNING" || round.status === "EVALUATING"
                  }
                >
                  {roundLabel(round.status)}
                </Status>
                <h3 className="t-title mt-2.5 text-[1rem] text-ink">
                  {round.title}
                </h3>
                <p className="t-mono mt-1.5 text-[0.6875rem] text-faint">
                  {round.models.join(" · ")}
                </p>
              </div>

              <div className="w-40 shrink-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="t-label text-[0.5625rem] text-faint">
                    Models done
                  </span>
                  <span className="t-num text-[1.125rem] text-ink">
                    {round.done}
                    <span className="text-muted">/{round.total}</span>
                  </span>
                </div>
                <Meter
                  value={round.total > 0 ? round.done / round.total : 0}
                  className="mt-2"
                  label={`${round.done} of ${round.total} models have finished`}
                />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One round on the list: preview, contenders, countdown, pool and odds. */
function RoundCard({
  round,
  onExpire,
}: {
  round: OpenRound;
  onExpire: () => void;
}) {
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

        {/* The pot, as a readout. Its size is not a target: there is no stake
            cap, so the capacity meter that used to sit here implied a goal the
            product does not have. What a reader compares is the price. */}
        <div className="shrink-0 text-right">
          <p className="t-label text-[0.5625rem] text-faint">Pot</p>
          <p className="t-num mt-1.5 text-[1.375rem] leading-none text-ink">
            {round.pot.toLocaleString(undefined, { maximumFractionDigits: 3 })}
            <span className="ml-1 text-xs text-muted">SOL</span>
          </p>
          <p className="t-mono mt-1.5 text-[0.5625rem] text-faint">
            {round.pot > 0
              ? "splits among the winner's backers"
              : "no wagers yet"}
          </p>
        </div>
      </div>

      {/* The three prices, in the same language as the round page's board:
          chance is the width of the bar, payout sits beside it, and each row's
          ink ties it to its line in a chart the list does not draw. */}
      <ul className="mt-5 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-3">
        {round.odds.map((model, index) => (
          <li key={model.modelId} className="bg-void-2/80 px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="truncate text-[0.8125rem] text-ink">
                {model.modelName}
              </p>
              <span
                className={
                  model.multiplier === null
                    ? "t-num shrink-0 text-[0.8125rem] text-faint"
                    : "t-num shrink-0 text-[0.8125rem] text-muted"
                }
              >
                {formatMultiplier(model.multiplier)}
              </span>
            </div>
            <div className="mt-2 flex items-baseline justify-between gap-2">
              <span className="t-num text-[1rem] leading-none text-ink">
                {(model.share * 100).toFixed(1)}
                <span className="text-[0.625rem] text-faint">%</span>
              </span>
              <span className="t-mono text-[0.5625rem] text-faint">
                {(model.staked / 1_000_000_000).toLocaleString(undefined, {
                  maximumFractionDigits: 3,
                })}{" "}
                SOL
              </span>
            </div>
            {/* Same weight of pale ink as this model's line would be. */}
            <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-white/[0.05]">
              <span
                aria-hidden="true"
                className="block h-full rounded-full"
                style={{
                  width: `${Math.max(0, Math.min(1, model.share)) * 100}%`,
                  background: modelInk(index),
                }}
              />
            </div>
          </li>
        ))}
      </ul>

      {backed.length > 0 && backed.length < round.odds.length ? (
        <p className="t-mono mt-3 text-[0.5625rem] text-faint">
          an unbacked model shows no payout — nobody is in that pool
        </p>
      ) : null}
    </Link>
  );
}

export default function CompetitionsPage() {
  const [rounds, setRounds] = useState<OpenRound[]>([]);
  const [live, setLive] = useState<LiveRound[]>([]);
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
        return {
          competitions: body.competitions as Array<{
            id: string;
            title: string;
            challenge_preview: string;
            models: string[];
            deadline: string;
            pool_sol: number;
            pool_capacity: number;
            odds: Array<{
              model_id: string;
              model_name: string;
              staked: number;
              multiplier: number | null;
              share: number;
            }>;
          }>,
          live: (body.live ?? []) as Array<{
            id: string;
            title: string;
            status: string;
            models: Array<{ id: string; name: string }>;
            progress: { done: number; total: number };
          }>,
        };
      })
      .then(({ competitions, live: liveRounds }) => {
        if (!active) return;
        setLive(
          liveRounds.map((round) => ({
            id: round.id,
            title: round.title,
            status: round.status,
            models: round.models.map((model) => model.name),
            done: round.progress.done,
            total: round.progress.total,
          })),
        );
        setRounds(
          competitions.map((competition) => ({
            id: competition.id,
            title: competition.title,
            preview: competition.challenge_preview,
            models: competition.models,
            deadline: competition.deadline,
            pot: competition.pool_sol ?? 0,
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

      <LiveStrip rounds={live} />

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
