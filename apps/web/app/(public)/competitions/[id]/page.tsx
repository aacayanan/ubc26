"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CountdownReadout } from "@/components/countdown";
import { SolRound } from "@/components/sol-round";
import { LiveRoundPanel } from "@/components/live-round-panel";
import { describeDeadline } from "@/lib/countdown";
import {
  CrosshairMark,
  Panel,
  RoundHash,
  Status,
  roundLabel,
  roundTone,
} from "@/components/ui";

interface RoundDetail {
  id: string;
  brief_title: string;
  brief_text: string;
  models: { id: string; name: string }[];
  deadline: string;
  /** Lifecycle status; the component reads it as `state`. */
  state: string;
}

/** What `GET /api/rounds/[id]` returns: `status`, not `state`. */
type ApiRound = Omit<RoundDetail, "state"> & { status: string };

export default function CompetitionDetailPage() {
  const params = useParams<{ id: string }>();
  const roundId = params?.id;

  const [round, setRound] = useState<RoundDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(roundId));
  // A load failure is not the same as "this round does not exist". Collapsing
  // them told a user with a flaky connection that the round was closed.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Load the round. `round` stays null while loading, on a 404, or on a failed
  // request — but those three now render differently.
  useEffect(() => {
    if (!roundId) return;
    let active = true;
    fetch(`/api/rounds/${roundId}`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 404) return null;
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error?.message ?? "Could not load the round");
        }
        return body.round as ApiRound;
      })
      .then((loaded) => {
        if (!active) return;
        // The API returns `status`; the component reads `state`. Normalise here
        // rather than at 15 call sites — reading a missing `state` silently made
        // every round look closed.
        setRound(loaded ? { ...loaded, state: loaded.status } : null);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setRound(null);
        setLoadError(
          err instanceof Error ? err.message : "Could not load the round",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [roundId, reloadKey]);

  // The initial round read is intentionally cheap, but the lifecycle changes
  // while the SOL pool is polling. Keep the parent status current so the live
  // surface mounts as soon as the ante window becomes live.
  useEffect(() => {
    if (!roundId) return;
    let active = true;
    const refreshStatus = async () => {
      const response = await fetch(`/api/rounds/${roundId}/progress`, {
        cache: "no-store",
      });
      if (!active || !response.ok) return;
      const progress = (await response.json()) as { status?: string };
      if (progress.status) {
        setRound((current) =>
          current ? { ...current, state: progress.status! } : current,
        );
      }
    };
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [roundId]);

  if (loading) {
    return (
      <div className="shell py-14 sm:py-20">
        <div className="panel-quiet mx-auto max-w-xl px-6 py-16 text-center">
          <p className="t-label text-[0.625rem] text-faint">Loading round…</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="shell py-14 sm:py-20">
        <div className="panel-quiet mx-auto flex max-w-xl flex-col items-center px-6 py-16 text-center">
          <div role="alert">
            <h1 className="t-title text-xl text-ink">
              This round could not be loaded.
            </h1>
            <p className="t-body mt-3 max-w-[44ch] text-sm text-muted">
              {loadError}
            </p>
          </div>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setReloadKey((key) => key + 1);
              }}
              className="btn btn-ghost btn-sm"
            >
              Try again
            </button>
            <Link href="/competitions" className="btn btn-ghost btn-sm">
              All rounds
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!round) {
    return (
      <div className="shell py-14 sm:py-20">
        <div className="panel-quiet mx-auto flex max-w-xl flex-col items-center px-6 py-16 text-center">
          <CrosshairMark className="text-faint" />
          <h1 className="t-title mt-6 text-xl text-ink">
            This round is closed.
          </h1>
          <p className="t-body mt-3 max-w-[44ch] text-sm text-muted">
            Nothing is open under this id — it may have settled and moved to
            results, or the link is stale.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link href="/competitions" className="btn btn-ghost btn-sm">
              All rounds
            </Link>
            <Link href="/results" className="btn btn-ghost btn-sm">
              Results
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Actionable means OPEN *and* inside the clock — F11 can lag a round's
  // deadline by a job interval.
  const deadline = describeDeadline(round.deadline);
  const isOpen = round.state === "OPEN" && !deadline.expired;

  // Two clocks, two layouts. While the ante is open the page leads with the
  // brief; once the round locks it is the show — a compact masthead, then the
  // live wager panel and the renders at the page's full width.
  const isLive = !isOpen;

  // What the round is doing, in one line. The live page has no room for the old
  // explanation panel; this is the same copy, kept where it still answers the
  // question a viewer arrives with.
  const liveNote =
    round.state === "EVALUATING"
      ? "Renders are in and the judge is ruling on conformance."
      : round.state === "SETTLED" || round.state === "ARCHIVED"
        ? "Its conformance result and the crowd's choice are recorded in Results."
        : round.state === "VOIDED"
          ? "No model conformed to the brief, so every wager is refunded."
          : round.state === "CANCELLED" || round.state === "FAILED"
            ? "No render ran, so the round is void and every wager is refunded."
            : round.state === "RETRYING"
              ? "A render or judge could not be reached, and the round is being retried rather than settled on a guess."
              : "The round has locked. Renders are being produced, and the crowd vote opens once they land.";

  return (
    <div className="shell pt-12 pb-12 sm:pt-14 sm:pb-14">
      <nav aria-label="Breadcrumb" className="mb-8 flex items-center gap-2.5">
        <Link href="/competitions" className="link t-label text-[0.625rem]">
          Rounds
        </Link>
        <span aria-hidden="true" className="t-mono text-[0.625rem] text-faint">
          /
        </span>
        <span className="t-label text-[0.625rem] text-muted">
          {round.brief_title}
        </span>
      </nav>

      {isLive ? (
        // The masthead is a document heading, not a card. The show below it is
        // the page; a glass slab above the renders made the brief look like the
        // headline exhibit and pushed three full-size panels past the fold.
        <header className="border-b border-hairline pb-4">
          <h1 className="t-title max-w-[44ch] text-[clamp(1.125rem,1.8vw,1.375rem)] text-ink">
            {round.brief_title}
          </h1>
          {/* The prompt stays on the page when the round is live: the audience
              needs to know what the models were asked to draw. */}
          <p className="t-body mt-1.5 max-w-[78ch] text-[0.8125rem] text-muted">
            {round.brief_text}
          </p>

          {/* Status is not repeated here — the live panel below polls it, and two
              dots reporting different states a poll apart is a defect, not a
              detail. The hash stays as the round's handle. */}
          <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="t-label text-[0.5625rem] text-faint">
                Contenders
              </span>
              {round.models.map((m) => (
                <span key={m.id} className="text-[0.8125rem] text-ink">
                  {m.name}
                </span>
              ))}
            </div>
            <RoundHash id={round.id} className="text-[0.625rem]" />
          </div>
        </header>
      ) : (
        <Panel className="px-7 py-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Status
              tone={roundTone(round.state)}
              pulse={round.state === "OPEN"}
            >
              {roundLabel(round.state)}
            </Status>
            <span className="t-mono flex items-center gap-1.5 text-[0.6875rem] text-muted">
              <span className="text-faint">closes in</span>
              <CountdownReadout
                deadline={round.deadline}
                className="t-num text-ink"
              />
            </span>
          </div>

          <div className="mt-4 flex flex-col gap-x-10 gap-y-2 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <h1 className="t-title max-w-[24ch] text-[clamp(1.6rem,2.6vw,2.05rem)] text-ink">
                {round.brief_title}
              </h1>
              <p className="t-body mt-3 max-w-[62ch] text-sm text-muted">
                {round.brief_text}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 lg:flex-col lg:items-end lg:gap-y-1.5">
              {round.models.map((m) => (
                <span key={m.id} className="flex items-baseline gap-2">
                  <span className="t-label text-[0.5625rem] text-faint">
                    Contender
                  </span>
                  <span className="text-[0.8125rem] text-ink">{m.name}</span>
                </span>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {isLive ? (
        <p className="t-body mt-4 max-w-[76ch] text-[0.8125rem] text-muted">
          {liveNote}
        </p>
      ) : null}
      {/* Every round is a Devnet SOL round: the wager flow (token meters, ante
          and live phases, pool, payouts), then the shared live show. */}
      <SolRound
        roundId={round.id}
        status={round.state}
        deadline={round.deadline}
        models={round.models}
      />
      <LiveRoundPanel
        roundId={round.id}
        initialStatus={round.state}
        className="mt-5"
      />
    </div>
  );
}
