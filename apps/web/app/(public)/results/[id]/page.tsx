"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { RoundRecords } from "@/components/round-records";
import type { ResultDisplayState, RenderedFrame } from "@ai-showdown/shared";
import {
  CrosshairMark,
  Meter,
  PageHeader,
  Panel,
  Readout,
  SectionHeading,
  Status,
} from "@/components/ui";
import { ReplayFrame } from "@/components/replay-frame";
import { formatMultiplier } from "@/lib/odds";

/* ------------------------------------------------------------------ *
 * API shape (snake_case), mapped to local camelCase interfaces below.
 * ------------------------------------------------------------------ */

interface ApiModel {
  model_id: string;
  name: string;
  ordinal: number;
  status:
    "conformed" | "not_conformed" | "forfeited" | "unavailable" | "pending";
  forfeit_reason: string | null;
  gate: {
    passed: boolean;
    failureReason: string | null;
    checks: Array<{ kind: string; passed: boolean; reason: string }>;
  } | null;
  judge: {
    verdict: "conformed" | "not_conformed" | "unavailable";
    reason: string;
    criteria: Array<{
      id: string;
      question: string;
      weight: number;
      passed: boolean;
      reason: string;
    }>;
  } | null;
  frames: RenderedFrame[];
  solution_code: string | null;
  staked: number;
  multiplier: number | null;
  share: number;
  is_winner: boolean;
  is_fan_favorite: boolean;
}

interface ApiResult {
  round_id: string;
  slug: string;
  brief_title: string;
  brief_prompt: string;
  status: string;
  revealed: boolean;
  display_state: ResultDisplayState;
  replay: {
    entry_point: string;
    frame_width: number;
    frame_height: number;
    target_duration_ms: number;
    frame_count: number;
  };
  outcome: {
    kind: "settled" | "voided";
    winner_model_id: string | null;
    fan_favorite_model_id: string | null;
    tie_break: "sole-conformer" | "crowd-vote" | "stable-order" | null;
    reason: string;
    all_forfeited: boolean;
  } | null;
  pool: {
    pot_sol: number;
    models: Array<{
      model_id: string;
      name: string;
      staked: number;
      multiplier: number | null;
      share: number;
    }>;
  };
  crowd: { counts: Record<string, number> } | null;
  models: ApiModel[];
  viewer_stake: {
    model_id: string;
    amount_sol: number;
    outcome: "won" | "lost" | "void" | null;
    payout_sol: number | null;
  } | null;
}

type Tone = "live" | "violet" | "ink" | "amber" | "idle";

/** Dot tone + word for a model's conformance status. Amber is never used here. */
function modelStatus(status: ApiModel["status"]): {
  tone: Tone;
  label: string;
} {
  switch (status) {
    case "conformed":
      return { tone: "ink", label: "Conformed" };
    case "not_conformed":
      return { tone: "idle", label: "Off brief" };
    case "forfeited":
      return { tone: "idle", label: "Forfeited" };
    case "unavailable":
      return { tone: "violet", label: "Judge unavailable" };
    default:
      return { tone: "idle", label: "Pending" };
  }
}

/** The overall outcome wording, driven by the resolved display state. */
function displayStateCopy(state: ResultDisplayState): {
  tone: Tone;
  label: string;
  headline: string;
} {
  switch (state) {
    case "winner":
      return {
        tone: "ink",
        label: "Settled",
        headline: "A model conformed to the brief",
      };
    case "tie":
      return {
        tone: "violet",
        label: "Settled",
        headline: "More than one model conformed",
      };
    case "all-forfeited":
      return {
        tone: "violet",
        label: "Void",
        headline: "Every model forfeited",
      };
    case "no-conformer":
      return { tone: "violet", label: "Void", headline: "No model conformed" };
    case "judge-unavailable":
      return {
        tone: "violet",
        label: "Pending",
        headline: "The judge could not rule yet",
      };
    case "voided":
      return { tone: "violet", label: "Void", headline: "This round was void" };
    case "pending":
      return {
        tone: "violet",
        label: "Pending",
        headline: "This round is not settled yet",
      };
  }
}

export default function ResultDetailPage() {
  const params = useParams<{ id: string }>();
  const roundId = params?.id;

  const [result, setResult] = useState<ApiResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(roundId));

  useEffect(() => {
    if (!roundId) return;
    let active = true;

    fetch(`/api/results/${roundId}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error?.message ?? "Could not load the result");
        }
        return body.result as ApiResult;
      })
      .then((loaded) => {
        if (active) {
          setResult(loaded);
          setError(null);
        }
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
  }, [roundId]);

  if (loading) {
    return (
      <div className="shell py-14 sm:py-16">
        <Panel quiet className="mx-auto max-w-xl px-6 py-16 text-center">
          <p className="t-mono text-[0.625rem] text-faint">Loading result…</p>
        </Panel>
      </div>
    );
  }

  if (error || !result) {
    return (
      <div className="shell py-14 sm:py-16">
        <div className="panel-quiet mx-auto flex max-w-xl flex-col items-center px-6 py-16 text-center">
          <CrosshairMark className="text-faint" />
          <h1 className="t-title mt-6 text-xl text-ink">
            This result could not be loaded.
          </h1>
          <p className="t-body mt-3 max-w-[44ch] text-sm text-muted">
            {error ?? "The round may not exist, or has not settled."}
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link href="/results" className="btn btn-ghost btn-sm">
              All results
            </Link>
            <Link href="/competitions" className="btn btn-ghost btn-sm">
              Rounds
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const state = displayStateCopy(result.display_state);
  const outcome = result.outcome;

  return (
    <div className="shell py-12 sm:py-14">
      <nav aria-label="Breadcrumb" className="mb-8 flex items-center gap-2.5">
        <Link href="/results" className="link t-label text-[0.625rem]">
          Results
        </Link>
        <span aria-hidden="true" className="t-mono text-[0.625rem] text-faint">
          /
        </span>
        <span className="t-label text-[0.625rem] text-muted">
          {result.brief_title}
        </span>
      </nav>

      <PageHeader
        title={result.brief_title}
        description={result.brief_prompt}
        actions={
          <Status tone={state.tone} pulse={result.display_state === "pending"}>
            {state.label}
          </Status>
        }
      />

      {/* The one-sentence reason the round landed where it did. */}
      {outcome?.reason ? (
        <Panel className="mt-6 p-5">
          <p className="t-label text-[0.5625rem] text-faint">Outcome</p>
          <p className="mt-2 max-w-[70ch] text-sm text-ink">{outcome.reason}</p>
        </Panel>
      ) : null}

      {/* Three rendered artifacts side by side, each replayable. */}
      <section className="mt-10">
        <SectionHeading
          aside={
            <span className="t-mono text-[0.625rem] text-faint">
              {state.headline}
            </span>
          }
        >
          The renders
        </SectionHeading>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          {result.models.map((model) => (
            <ModelPanel
              key={model.model_id}
              model={model}
              replay={result.replay}
            />
          ))}
        </div>
      </section>

      {/* Final odds vs outcome. */}
      <section className="mt-12">
        <SectionHeading
          aside={
            <span className="t-mono text-[0.625rem] text-faint">
              final odds
            </span>
          }
        >
          The pool
        </SectionHeading>

        <Panel className="mt-4 p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className="t-body text-sm text-muted">
              Devnet SOL wagered on which model would conform. Backers of the
              winner split the pot pro-rata.
            </p>
            <p className="t-num text-[1.375rem] text-ink">
              {result.pool.pot_sol.toLocaleString(undefined, {
                maximumFractionDigits: 4,
              })}
              <span className="ml-1 text-xs text-muted">SOL</span>
            </p>
          </div>

          <ul className="mt-5 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline">
            {result.pool.models.map((model) => (
              <li
                key={model.model_id}
                className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-void-2/80 px-4 py-3.5"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span className="truncate text-[0.875rem] text-ink">
                    {model.name}
                  </span>
                  {model.model_id === outcome?.winner_model_id ? (
                    <Status tone="ink">Won</Status>
                  ) : null}
                </div>
                <div className="w-24 text-right">
                  <p className="t-mono text-[0.625rem] text-faint">staked</p>
                  <p className="t-num text-[0.8125rem] text-ink">
                    {model.staked.toLocaleString(undefined, {
                      maximumFractionDigits: 4,
                    })}
                  </p>
                </div>
                <div className="w-24 text-right">
                  <p className="t-mono text-[0.625rem] text-faint">
                    multiplier
                  </p>
                  <p
                    className={
                      model.multiplier === null
                        ? "t-num text-[0.8125rem] text-faint"
                        : "t-num text-[0.8125rem] text-ink"
                    }
                  >
                    {formatMultiplier(model.multiplier)}
                  </p>
                </div>
                <div className="w-32 shrink-0">
                  <Meter
                    value={model.share}
                    label={`${model.name} holds ${Math.round(model.share * 100)} percent of the pool`}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      {/* Crowd's fan-favorite — displayed, not voted on here (F32 owns voting). */}
      {/* F22: the settlement (and the round's other records) as published on
          Devnet, checkable against this result. */}
      {roundId ? <RoundRecords roundId={roundId} /> : null}

      <section className="mt-12">
        <SectionHeading>Crowd&rsquo;s choice</SectionHeading>
        <Panel className="mt-4 p-6">
          {result.crowd && Object.keys(result.crowd.counts).length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="t-label text-[0.5625rem] text-faint">
                  Fan favorite
                </p>
                <p className="mt-1.5 text-[1.0625rem] text-ink">
                  {modelName(result, outcome?.fan_favorite_model_id) ?? "—"}
                </p>
              </div>
              <p className="t-body max-w-[46ch] text-xs text-muted">
                The crowd vote never moves SOL and never changes the conformance
                outcome.
              </p>
            </div>
          ) : (
            <p className="t-body text-sm text-muted">
              No crowd vote was recorded for this round.
            </p>
          )}

          {result.crowd && Object.keys(result.crowd.counts).length > 0 ? (
            <ul className="mt-4 grid gap-2">
              {result.models.map((model) => {
                const votes = result.crowd?.counts[model.model_id] ?? 0;
                return (
                  <li
                    key={model.model_id}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="text-[0.8125rem] text-muted">
                      {model.name}
                    </span>
                    <span className="t-num text-[0.8125rem] text-ink">
                      {votes.toLocaleString()} votes
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </Panel>
      </section>

      {/* The viewer's own stake, when there is one. */}
      {result.viewer_stake ? (
        <section className="mt-12">
          <SectionHeading>Your prediction</SectionHeading>
          <Panel className="mt-4 flex flex-wrap items-center justify-between gap-4 p-6">
            <div>
              <p className="t-label text-[0.5625rem] text-faint">You backed</p>
              <p className="mt-1.5 text-[1.0625rem] text-ink">
                {modelName(result, result.viewer_stake.model_id) ?? "—"}
              </p>
            </div>
            <div className="flex items-center gap-8">
              <Readout
                label="Wagered"
                value={result.viewer_stake.amount_sol.toLocaleString(
                  undefined,
                  { maximumFractionDigits: 4 },
                )}
                suffix="SOL"
              />
              <Readout
                label="Returned"
                value={
                  result.viewer_stake.payout_sol === null
                    ? "—"
                    : result.viewer_stake.payout_sol.toLocaleString(undefined, {
                        maximumFractionDigits: 4,
                      })
                }
                suffix={
                  result.viewer_stake.payout_sol === null ? undefined : "SOL"
                }
              />
              <Status
                tone={result.viewer_stake.outcome === "won" ? "ink" : "idle"}
              >
                {result.viewer_stake.outcome === "won"
                  ? "Won"
                  : result.viewer_stake.outcome === "lost"
                    ? "Lost"
                    : result.viewer_stake.outcome === "void"
                      ? "Void"
                      : "Open"}
              </Status>
            </div>
          </Panel>
        </section>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ModelPanel({
  model,
  replay,
}: {
  model: ApiModel;
  replay: ApiResult["replay"];
}) {
  const status = modelStatus(model.status);

  return (
    <Panel className="flex flex-col p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[0.9375rem] text-ink">{model.name}</p>
        <Status tone={status.tone}>{status.label}</Status>
      </div>

      <div className="mt-4">
        {/* The replay degrades to a stored frame if the code throws. */}
        <ReplayFrame
          source={model.solution_code}
          entryPoint={replay.entry_point}
          frameWidth={replay.frame_width}
          frameHeight={replay.frame_height}
          targetDurationMs={replay.target_duration_ms}
          fallbackFrames={model.frames}
          label={model.name}
        />
      </div>

      {/* Why: reward reading beats reading code. */}
      <div className="mt-4 space-y-2.5">
        {model.is_winner ? (
          <p className="t-mono text-[0.625rem] tracking-[0.1em] text-violet">
            CONFORMED · POOL WINNER
          </p>
        ) : null}
        {model.forfeit_reason ? (
          <p className="t-body text-xs leading-relaxed text-muted">
            <span className="text-ink">Forfeited. </span>
            {model.forfeit_reason}
          </p>
        ) : model.judge ? (
          <p className="t-body text-xs leading-relaxed text-muted">
            {model.judge.reason}
          </p>
        ) : model.status === "pending" ? (
          <p className="t-body text-xs leading-relaxed text-faint">
            Waiting on a verdict.
          </p>
        ) : null}
      </div>

      {/* Judge criteria with weight — how much each answer counted. */}
      {model.judge && model.judge.criteria.length > 0 ? (
        <details className="mt-3">
          <summary className="t-label cursor-pointer text-[0.5625rem] text-muted">
            Judge criteria
          </summary>
          <ul className="mt-2 space-y-2">
            {model.judge.criteria.map((criterion) => (
              <li key={criterion.id}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[0.6875rem] text-ink">
                    {criterion.question || criterion.id}
                  </p>
                  <span className="t-mono shrink-0 text-[0.5625rem] text-faint">
                    {(criterion.weight * 100).toFixed(0)}%
                  </span>
                </div>
                <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-muted">
                  {criterion.passed ? "Passed" : "Failed"}
                  {criterion.reason ? ` — ${criterion.reason}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Gate checks, collapsed — the deterministic floor behind a forfeit. */}
      {model.gate && model.gate.checks.length > 0 ? (
        <details className="mt-3">
          <summary className="t-label cursor-pointer text-[0.5625rem] text-muted">
            Deterministic checks
          </summary>
          <ul className="mt-2 space-y-1.5">
            {model.gate.checks.map((check) => (
              <li
                key={check.kind}
                className="flex items-start justify-between gap-3"
              >
                <span className="t-mono text-[0.5625rem] text-faint">
                  {check.kind.replace(/_/g, " ")}
                </span>
                <span
                  className={
                    check.passed
                      ? "text-[0.625rem] text-muted"
                      : "text-[0.625rem] text-magenta"
                  }
                >
                  {check.passed ? "pass" : check.reason || "fail"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* The code itself: shown as text, never executed here. The replay above
          runs it only inside the quarantined iframe; this is for reading. */}
      {model.solution_code ? (
        <details className="mt-3">
          <summary className="t-label cursor-pointer text-[0.5625rem] text-muted">
            Code
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-hairline bg-void p-3 text-[0.625rem] leading-relaxed text-muted">
            <code>{model.solution_code}</code>
          </pre>
        </details>
      ) : null}
    </Panel>
  );
}

function modelName(
  result: ApiResult,
  modelId: string | null | undefined,
): string | null {
  if (!modelId) return null;
  return result.models.find((m) => m.model_id === modelId)?.name ?? null;
}
