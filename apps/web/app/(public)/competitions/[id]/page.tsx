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

  return (
    <div className="shell py-12 sm:py-14">
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

      <div className="grid gap-3 lg:grid-cols-[1.35fr_1fr] lg:items-start">
        <div className="space-y-3">
          <Panel className="p-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Status
                tone={roundTone(round.state)}
                pulse={round.state === "OPEN"}
              >
                {roundLabel(round.state)}
              </Status>
              {isOpen ? (
                <span className="t-mono flex items-center gap-1.5 text-[0.6875rem] text-muted">
                  <span className="text-faint">closes in</span>
                  <CountdownReadout
                    deadline={round.deadline}
                    className="t-num text-ink"
                  />
                </span>
              ) : (
                <span className="t-mono text-[0.6875rem] text-faint">
                  {new Date(round.deadline).toLocaleString()}
                </span>
              )}
            </div>

            <h1 className="t-title mt-5 text-[clamp(1.6rem,3.2vw,2.25rem)] text-ink">
              {round.brief_title}
            </h1>
            <p className="t-body mt-4 max-w-[60ch] text-sm text-muted">
              {round.brief_text}
            </p>

            <div className="mt-7 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-3">
              {round.models.map((m) => (
                <div key={m.id} className="bg-void-2/80 px-4 py-3.5">
                  <p className="t-label text-[0.5625rem] text-faint">
                    Contender
                  </p>
                  <p className="mt-1 text-[0.875rem] text-ink">{m.name}</p>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <SolRound
          roundId={round.id}
          status={round.state}
          deadline={round.deadline}
          models={round.models}
        />
      </div>

      {/* SOL rounds bet live during generation, so the show is always on:
          each model's code streaming, and its render once that code compiles. */}
      <LiveRoundPanel roundId={round.id} initialStatus={round.state} />
    </div>
  );
}
