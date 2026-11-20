"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  EmptyState,
  Meter,
  PageHeader,
  Panel,
  SectionHeading,
  Status,
  roundLabel,
  roundTone,
} from "@/components/ui";

/**
 * Historical model performance (F25).
 *
 * Two records that are never merged into one "score": how often a model
 * CONFORMED to the brief (the judge's measured ruling), and how often the crowd
 * NAMED IT BEST (the fan-favorite vote). They answer different questions, and
 * `PRODUCT.md` says people follow models the way they follow competitors, so
 * the page shows each record on its own.
 *
 * Rounds that produced no result are labeled, not dropped: the panel carries a
 * per-model void/failed count and the page closes with the list of rounds that
 * did not settle, each with its reason. A model is never silently missing a
 * race it took part in.
 */

type ModelRoundOutcome = "settled" | "voided" | "unsettled";

type ConformanceRow =
  "conformed" | "not_conformed" | "forfeited" | "unavailable";

interface ModelRecentRound {
  round_id: string;
  round_slug: string;
  brief_title: string;
  outcome: ModelRoundOutcome;
  conformance: ConformanceRow | null;
  is_winner: boolean;
  is_crowd_pick: boolean;
  decided_at: string;
}

interface ModelStat {
  model_id: string;
  name: string;
  rounds: number;
  settled_rounds: number;
  conformance_wins: number;
  round_wins: number;
  crowd_wins: number;
  forfeits: number;
  conformance_rate: number | null;
  crowd_win_rate: number | null;
  voided_rounds: number;
  unsettled_rounds: number;
  recent: ModelRecentRound[];
}

interface HistoryGap {
  round_id: string;
  round_slug: string;
  brief_title: string;
  status: string;
  outcome: "voided" | "unsettled";
  reason: string | null;
  decided_at: string;
}

interface AnalyticsResponse {
  models: ModelStat[];
  gaps: HistoryGap[];
  scope: {
    settled_rounds: number;
    voided_rounds: number;
    unsettled_rounds: number;
  };
}

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** The one conformance word for a model's most recent round (dot + word). */
function conformanceWord(row: ModelRecentRound) {
  if (row.outcome === "voided") {
    return <Status tone="amber">Void</Status>;
  }
  if (row.outcome === "unsettled") {
    return <Status tone="idle">No result</Status>;
  }
  switch (row.conformance) {
    case "conformed":
      return <Status tone="ink">Conformed</Status>;
    case "not_conformed":
      return <Status tone="idle">Off brief</Status>;
    case "forfeited":
      return <Status tone="idle">Forfeited</Status>;
    case "unavailable":
      return <Status tone="violet">Unjudged</Status>;
    default:
      return <Status tone="idle">Settled</Status>;
  }
}

export default function ModelsPage() {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/models/analytics", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(
            body.error?.message ?? "Could not load model history",
          );
        }
        return body as AnalyticsResponse;
      })
      .then((loaded) => {
        if (active) setData(loaded);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load model history",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="shell py-14 sm:py-16">
      <PageHeader
        title="Models"
        description="Two separate records that are never merged: how often a model conformed to the brief, and how often the crowd named it best. Only comparable rounds count — the post-pivot visual briefs."
      />

      <div className="mt-10">
        {error ? (
          <div role="alert">
            <Panel quiet className="px-5 py-8 text-center">
              <Status tone="amber">Unavailable</Status>
              <p className="mt-3 text-[0.9375rem] text-ink">
                Model history could not be loaded.
              </p>
              <p className="t-body mt-2 text-sm text-muted">{error}</p>
            </Panel>
          </div>
        ) : !data ? (
          <Panel quiet className="px-5 py-8 text-center" aria-busy="true">
            <p className="t-mono text-[0.625rem] text-faint">
              Loading model history…
            </p>
          </Panel>
        ) : data.models.length === 0 ? (
          <EmptyState
            title="No settled rounds yet."
            action={
              <Link href="/competitions" className="btn btn-ghost btn-sm">
                Browse open rounds
              </Link>
            }
          >
            A model&rsquo;s record appears here after a round settles — how it
            was judged against the brief, and how the crowd voted. Nothing is
            estimated in advance.
          </EmptyState>
        ) : (
          <>
            <ScopeLine scope={data.scope} />

            <ul className="mt-6 grid gap-3 lg:grid-cols-2">
              {data.models.map((model) => (
                <li key={model.model_id}>
                  <ModelCard model={model} />
                </li>
              ))}
            </ul>

            {data.gaps.length > 0 ? (
              <section className="mt-14">
                <SectionHeading aside={<GapCount gaps={data.gaps} />}>
                  Rounds without a result
                </SectionHeading>
                <p className="t-body mt-2 max-w-[62ch] text-sm text-muted">
                  These comparable rounds did not settle. They are named here
                  rather than quietly left out of the records above, so a void
                  never looks like a race nobody entered.
                </p>
                <ul className="mt-5 grid gap-2">
                  {data.gaps.map((gap) => (
                    <li key={gap.round_id}>
                      <GapRow gap={gap} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function ScopeLine({ scope }: { scope: AnalyticsResponse["scope"] }) {
  const parts = [`${scope.settled_rounds} settled`];
  if (scope.voided_rounds > 0) parts.push(`${scope.voided_rounds} void`);
  if (scope.unsettled_rounds > 0)
    parts.push(`${scope.unsettled_rounds} no result`);

  return (
    <p className="t-mono text-[0.625rem] text-faint">
      Across {parts.join(" · ")} comparable round
      {scope.settled_rounds + scope.voided_rounds + scope.unsettled_rounds === 1
        ? ""
        : "s"}
      .
    </p>
  );
}

function ModelCard({ model }: { model: ModelStat }) {
  const noResult = model.voided_rounds + model.unsettled_rounds;

  return (
    <Panel className="p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="t-title text-[1.0625rem] text-ink">{model.name}</h2>
        <span className="t-mono text-[0.625rem] text-faint">
          {model.rounds} round{model.rounds === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <RateBlock
          label="Conformance"
          rate={model.conformance_rate}
          detail={`${model.conformance_wins} conformed`}
          caption="Judge's ruling across the rounds it was judged"
        />
        <RateBlock
          label="Crowd"
          rate={model.crowd_win_rate}
          detail={`${model.crowd_wins} named best`}
          caption="Share of settled rounds the crowd picked it"
        />
      </div>

      <dl className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-hairline bg-hairline">
        {[
          ["Round wins", model.round_wins],
          ["Forfeits", model.forfeits],
          ["No result", noResult],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-void-2/80 px-3 py-2.5">
            <dt className="t-label text-[0.5rem] text-faint">{label}</dt>
            <dd className="t-num mt-1 text-sm text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      {noResult > 0 ? (
        <p className="t-body mt-3 text-xs text-faint">
          {model.voided_rounds > 0 && model.unsettled_rounds > 0
            ? `${model.voided_rounds} void · ${model.unsettled_rounds} with no result`
            : model.voided_rounds > 0
              ? `${model.voided_rounds} void`
              : `${model.unsettled_rounds} with no result`}{" "}
          — excluded from both rates, counted here.
        </p>
      ) : null}

      <div className="mt-6 border-t border-hairline pt-4">
        <p className="t-label text-[0.5625rem] text-faint">Recent rounds</p>
        <ul className="mt-3 grid gap-2.5">
          {model.recent.map((row) => (
            <li
              key={row.round_id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
            >
              <Link
                href={`/results/${row.round_id}`}
                className="t-body min-w-0 truncate text-[0.8125rem] text-muted transition-colors hover:text-ink"
              >
                {row.brief_title}
              </Link>
              <span className="flex items-center gap-3">
                {row.is_crowd_pick ? (
                  <span className="t-label text-[0.5rem] text-violet">
                    Crowd
                  </span>
                ) : null}
                {conformanceWord(row)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function RateBlock({
  label,
  rate,
  detail,
  caption,
}: {
  label: string;
  rate: number | null;
  detail: string;
  caption: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="t-label text-[0.5625rem] text-faint">{label}</span>
        <span className="t-num text-[0.8125rem] text-ink">{pct(rate)}</span>
      </div>
      <Meter
        value={rate ?? 0}
        className="mt-2"
        label={
          rate === null
            ? `${label}: no rounds to measure yet`
            : `${label}: ${pct(rate)}, ${detail}`
        }
      />
      <p className="t-mono mt-2 text-[0.5625rem] text-faint">{caption}</p>
    </div>
  );
}

function GapCount({ gaps }: { gaps: HistoryGap[] }) {
  return (
    <span className="t-mono text-[0.625rem] text-faint">
      {gaps.length} round{gaps.length === 1 ? "" : "s"}
    </span>
  );
}

function GapRow({ gap }: { gap: HistoryGap }) {
  return (
    <div className="panel-quiet flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Status tone={roundTone(gap.status)}>{roundLabel(gap.status)}</Status>
        <span className="t-body min-w-0 truncate text-[0.8125rem] text-ink">
          {gap.brief_title}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="t-mono text-[0.5625rem] text-faint">
          {new Date(gap.decided_at).toLocaleDateString()}
        </span>
        <Link
          href={`/results/${gap.round_id}`}
          className="btn btn-ghost btn-sm"
        >
          Details
        </Link>
      </div>
    </div>
  );
}
