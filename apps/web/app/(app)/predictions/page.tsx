"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, PageHeader, Panel, Status } from "@/components/ui";

type StakeState =
  "open" | "locked" | "running" | "settling" | "won" | "lost" | "void";

interface StakeRecord {
  id: string;
  roundId: string;
  briefTitle: string;
  pickedModel: string;
  points: number;
  awarded: number | null;
  outcome: "won" | "lost" | "void" | null;
  state: StakeState;
  roundStatus: string;
  resultHref: string | null;
  createdAt: string;
}

type Tone = "live" | "violet" | "ink" | "amber" | "idle";

/**
 * The lifecycle of a stake, as one dot + word.
 *
 * `open` / `locked` / `running` / `settling` are distinguishable clocks (F26):
 * only `open` can still be changed; `locked` and `running` are sealed while the
 * reveal plays out; `settling` is a settled round whose payout row has not been
 * read back yet. The terminal states are `won` / `lost` / `void`.
 */
function stakeStatus(stake: StakeRecord): { tone: Tone; label: string } {
  switch (stake.state) {
    case "open":
      return { tone: "live", label: "Open — stake editable" };
    case "locked":
      return { tone: "violet", label: "Sealed" };
    case "running":
      return { tone: "violet", label: "Running" };
    case "settling":
      return { tone: "idle", label: "Awaiting payout" };
    case "won":
      return { tone: "ink", label: "Won" };
    case "lost":
      return { tone: "idle", label: "Lost" };
    case "void":
      return { tone: "amber", label: "Void" };
  }
}

/** One line explaining what this stake's state means to the account. */
function stateNote(stake: StakeRecord): string {
  switch (stake.state) {
    case "open":
      return "The round is still taking stakes — you can change your pick before the deadline.";
    case "locked":
      return "The betting clock closed before anything rendered. Your stake is fixed.";
    case "running":
      return "Models are rendering. Your stake is fixed and waits for settlement.";
    case "settling":
      return "The round has settled; the payout record is being written.";
    case "won":
      return "Your model conformed — this stake took a pro-rata share of the pool.";
    case "lost":
      return "Your model did not take the conformance outcome.";
    case "void":
      return "The round did not produce a winner, so the stake returned nothing and cost nothing.";
  }
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
            {stakes.map((stake) => {
              const status = stakeStatus(stake);
              return (
                <li key={stake.id}>
                  <Panel className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <Link
                          href={`/competitions/${stake.roundId}`}
                          className="link text-[0.9375rem] text-ink"
                        >
                          {stake.briefTitle}
                        </Link>
                        <p className="t-mono mt-1 text-[0.6875rem] text-faint">
                          {stake.pickedModel} · {stake.points} pts ·{" "}
                          {new Date(stake.createdAt).toLocaleDateString()}
                        </p>
                        <p className="t-body mt-2 text-xs text-muted">
                          {stateNote(stake)}
                        </p>
                      </div>

                      <div className="flex shrink-0 flex-col items-end gap-2">
                        <Status tone={status.tone}>{status.label}</Status>
                        {stake.awarded !== null ? (
                          <span className="t-num text-[0.8125rem] text-muted">
                            {stake.awarded > 0 ? `+${stake.awarded}` : "0"} pts
                          </span>
                        ) : null}
                        {stake.resultHref ? (
                          <Link
                            href={stake.resultHref}
                            className="link t-label text-[0.625rem]"
                          >
                            Why this resolved &rarr;
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  </Panel>
                </li>
              );
            })}
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
