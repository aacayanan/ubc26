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
 *
 * It uses the same tile and the same grid as the open list beneath it, so the
 * page reads as one board of rounds in different states rather than two
 * differently-shaped lists stapled together.
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

      <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rounds.map((round) => (
          <li key={round.id}>
            <Link
              href={`/competitions/${round.id}`}
              className="panel panel-interactive flex h-full flex-col p-4"
            >
              <div className="flex items-center justify-end gap-2">
                <span className="t-num shrink-0 text-[0.8125rem] leading-none text-ink">
                  {round.done}
                  <span className="text-[0.6875rem] text-faint">
                    /{round.total}
                  </span>
                </span>
              </div>

              <h3 className="t-title mt-2.5 line-clamp-2 text-[0.9375rem] text-ink">
                {round.title}
              </h3>
              <p className="t-mono mt-1 truncate text-[0.6875rem] text-faint">
                {round.models.join(" · ")}
              </p>

              <div className="mt-auto pt-3">
                <Meter
                  value={round.total > 0 ? round.done / round.total : 0}
                  label={`${round.done} of ${round.total} models have finished`}
                />
                <p className="t-label mt-2 text-[0.5rem] text-faint">
                  models done
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One round on the board — a market tile, not a page.
 *
 * The list is a board you scan: a grid of tiles, each one small enough to read
 * at a glance and to compare against its neighbours. The brief names the tile
 * and the clock sits beside the state; beneath them each contender gets one
 * line — name, payout, chance — so the three prices are the thing the eye lands
 * on rather than the last thing under a paragraph.
 *
 * Chance is the numeral in the right-hand box and the width of the bar beneath
 * the name; payout sits immediately before it. Both are readouts, so both are
 * tabular mono. The bar keeps the model's own ink, tying the row to its line in
 * the round page's ribbon without drawing a second chart here.
 */
function RoundCard({
  round,
  onExpire,
}: {
  round: OpenRound;
  onExpire: () => void;
}) {
  return (
    <Link
      href={`/competitions/${round.id}`}
      className="panel panel-interactive group flex h-full flex-col p-4"
    >
      {/* The clock is the tile's live element. The state badge that used to sit
          beside it ("Staking open") is gone: an open round is the only thing
          this list shows, so the badge repeated the page's own heading. */}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
        <span className="t-mono flex items-center gap-1.5 text-[0.625rem] text-muted">
          <span className="text-faint">closes</span>
          <CountdownReadout
            deadline={round.deadline}
            onExpire={onExpire}
            className="t-num text-ink"
          />
        </span>
      </div>

      <h2 className="t-title mt-2.5 line-clamp-2 text-[0.9375rem] text-ink">
        {round.title}
      </h2>
      <p className="t-body mt-1 line-clamp-1 text-[0.75rem] text-faint">
        {round.preview}
      </p>

      {/* Both columns are named, matching the round page's board. The numeral
          under `chance` is the model's share of the pot, and naming it is what
          makes that legible: the underline draws the same value but says
          nothing about what it measures, so an unlabelled `42%` had to be
          reverse-engineered from the bar beside it. `payout` and `chance` read
          as the pair they are — how likely, and what it pays. */}
      <div className="mt-3 flex items-baseline gap-2.5 px-1.5">
        <span className="min-w-0 flex-1" />
        <span className="t-label hidden shrink-0 text-[0.5rem] text-faint sm:block">
          payout
        </span>
        <span className="t-label flex w-[2.9rem] shrink-0 justify-center text-[0.5rem] text-faint">
          chance
        </span>
      </div>

      {/* The three prices. One row per contender, the same language as the
          round page's board: the bar is the chance, the numeral is the price,
          the multiplier is the payoff. */}
      <ul className="mt-1 grid gap-0.5">
        {round.odds.map((model, index) => (
          <li
            key={model.modelId}
            className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors group-hover:bg-white/[0.02]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.8125rem] leading-tight text-ink">
                {model.modelName}
              </span>
              {/* The name's underline is the chance: its own ink, its own
                  width, so a side is scannable without reading the number. */}
              <span
                aria-hidden="true"
                className="mt-1 block h-[2px] w-full overflow-hidden rounded-full bg-white/[0.05]"
              >
                <span
                  className="block h-full rounded-full transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
                  style={{
                    width: `${Math.max(0, Math.min(1, model.share)) * 100}%`,
                    background: modelInk(index),
                  }}
                />
              </span>
            </span>

            <span
              className={
                model.multiplier === null
                  ? "t-num hidden shrink-0 text-[0.6875rem] text-faint sm:block"
                  : "t-num hidden shrink-0 text-[0.6875rem] text-muted sm:block"
              }
            >
              {formatMultiplier(model.multiplier)}
            </span>

            {/* The price, boxed: the one number on the row that is a reading
                rather than a label, so it gets its own boundary. Fixed width so
                the boxes line up down the tile and the column of chances reads
                as one ladder. */}
            <span className="t-num flex h-[1.6rem] w-[2.9rem] shrink-0 items-baseline justify-center gap-px rounded-lg border border-hairline bg-white/[0.03] pt-[0.28rem] text-[0.9375rem] leading-none text-ink">
              {(model.share * 100).toFixed(0)}
              <span className="text-[0.625rem] text-faint">%</span>
            </span>
          </li>
        ))}
      </ul>

      {/* The pot closes the tile as a readout, not a target: there is no stake
          cap, so the number only says how much is riding on the round. */}
      <div className="mt-auto flex items-baseline justify-between gap-3 border-t border-hairline pt-2.5">
        <span className="t-label text-[0.5rem] text-faint">Pot</span>
        <span className="t-num text-[0.8125rem] leading-none text-ink">
          {round.pot.toLocaleString(undefined, { maximumFractionDigits: 3 })}
          <span className="ml-1 text-[0.625rem] text-muted">SOL</span>
        </span>
      </div>
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
      <PageHeader title="Rounds" />

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
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rounds.map((round) => (
              <li key={round.id}>
                <RoundCard round={round} onExpire={reload} />
              </li>
            ))}
          </ul>
        )}
      </div>

    </div>
  );
}
