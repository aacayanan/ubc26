"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CountdownReadout } from "@/components/countdown";
import { describeDeadline } from "@/lib/countdown";
import {
  CrosshairMark,
  Meter,
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
  pool_points: number;
  pool_capacity: number;
  user_stake: { model_id: string; points: number } | null;
}

/** What `GET /api/rounds/[id]` returns: `status`, not `state`. */
type ApiRound = Omit<RoundDetail, "state"> & { status: string };

export default function CompetitionDetailPage() {
  const router = useRouter();
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

  const [selected, setSelected] = useState<string>("");
  const [stake, setStake] = useState<string>("250");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!round) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/rounds/${round.id}/stakes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: selected, points: Number(stake) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? "Could not place the stake");
      }
      router.push("/predictions");
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Could not place the stake",
      );
    } finally {
      setSaving(false);
    }
  }

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

  // Actionable means OPEN *and* inside the clock. `place_stake` rejects a
  // post-deadline stake anyway, but offering the form would promise something
  // the server will refuse — F11 can lag a round's deadline by a job interval.
  const deadline = describeDeadline(round.deadline);
  const isOpen = round.state === "OPEN" && !deadline.expired;
  const staked = round.user_stake !== null;
  const poolUsed = round.pool_points / Math.max(round.pool_capacity, 1);

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

          <Panel className="p-7">
            <div className="flex items-center justify-between">
              <h2 className="t-title text-[1rem] text-ink">The pool</h2>
              <span className="t-num text-[0.8125rem] text-muted">
                {round.pool_points.toLocaleString()} pts
              </span>
            </div>
            <Meter
              value={poolUsed}
              className="mt-4"
              label={`Pool is ${Math.round(poolUsed * 100)} percent of capacity`}
            />
            <p className="t-body mt-3 text-xs text-faint">
              Points, not money. The pot is split pro-rata among the backers of
              the model that conforms to the brief.
            </p>
          </Panel>
        </div>

        {/* Stake panel */}
        <Panel className="p-7 lg:sticky lg:top-24">
          {isOpen && !staked ? (
            <form onSubmit={handleSubmit}>
              <div className="flex items-center justify-between">
                <h2 className="t-title text-[1rem] text-ink">
                  Stake on a model
                </h2>
                <span className="t-mono text-[0.625rem] text-faint">
                  before deadline
                </span>
              </div>

              <fieldset className="mt-5">
                <legend className="t-label text-[0.5625rem] text-faint">
                  Which model conforms?
                </legend>
                <div className="mt-2.5 space-y-2">
                  {round.models.map((m) => {
                    const active = selected === m.id;
                    return (
                      <label
                        key={m.id}
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet ${
                          active
                            ? "border-magenta bg-magenta/[0.07]"
                            : "border-[var(--control-line)] bg-white/[0.015] hover:border-white/45"
                        }`}
                      >
                        <input
                          type="radio"
                          name="model"
                          value={m.id}
                          checked={active}
                          onChange={() => setSelected(m.id)}
                          className="sr-only"
                        />
                        {/* filled vs hollow ring: selection never relies on colour */}
                        <span
                          aria-hidden="true"
                          className={`grid size-[15px] shrink-0 place-items-center rounded-full border ${
                            active ? "border-magenta" : "border-white/40"
                          }`}
                        >
                          <span
                            className={`size-[7px] rounded-full ${
                              active ? "bg-magenta" : "bg-transparent"
                            }`}
                          />
                        </span>
                        <span className="text-[0.875rem] text-ink">
                          {m.name}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <div className="mt-5">
                <label
                  htmlFor="stake"
                  className="t-label block text-[0.5625rem] text-faint"
                >
                  Stake
                </label>
                <div className="mt-2.5 flex items-center gap-2">
                  <input
                    id="stake"
                    type="number"
                    min={10}
                    step={10}
                    value={stake}
                    onChange={(e) => setStake(e.target.value)}
                    aria-describedby="stake-hint"
                    className="field t-num"
                  />
                  <span className="t-mono shrink-0 text-[0.6875rem] text-faint">
                    pts
                  </span>
                </div>
                <p
                  id="stake-hint"
                  className="t-mono mt-2 text-[0.625rem] text-faint"
                >
                  minimum 10 points · one stake per round
                </p>
              </div>

              {error ? (
                <p
                  role="alert"
                  className="mt-4 rounded-lg border border-magenta/30 bg-magenta/[0.07] px-3 py-2 text-xs text-magenta"
                >
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={saving || !selected || Number(stake) < 10}
                className="btn btn-solid btn-block mt-6"
              >
                {saving ? "Sealing…" : "Seal this stake"}
              </button>

              <p className="t-mono mt-3 text-center text-[0.625rem] leading-relaxed text-faint">
                committed on devnet as hash(pick, stake, nonce)
              </p>
            </form>
          ) : staked ? (
            <div className="text-center">
              <Status tone="ink">Sealed</Status>
              <p className="t-title mt-5 text-lg text-ink">
                Your stake is in the pool.
              </p>
              <p className="t-body mt-2 text-sm text-muted">
                It is locked for this round, and settles with the pool once the
                round settles.
              </p>
              <Link
                href="/predictions"
                className="btn btn-ghost btn-block mt-6"
              >
                My predictions
              </Link>
            </div>
          ) : (
            <div className="text-center">
              <Status
                tone={
                  round.state === "VOIDED"
                    ? "amber"
                    : round.state === "SETTLED" || round.state === "ARCHIVED"
                      ? "ink"
                      : "violet"
                }
              >
                {roundLabel(round.state)}
              </Status>
              <p className="t-title mt-5 text-lg text-ink">
                {round.state === "SETTLED" || round.state === "ARCHIVED"
                  ? "This round has settled."
                  : round.state === "VOIDED"
                    ? "This round was void."
                    : round.state === "CANCELLED" || round.state === "FAILED"
                      ? "This round did not run."
                      : "Staking is closed."}
              </p>
              <p className="t-body mt-2 text-sm text-muted">
                {round.state === "EVALUATING"
                  ? "Renders are in and the judge is ruling on conformance."
                  : round.state === "SETTLED" || round.state === "ARCHIVED"
                    ? "Its conformance result and the crowd's choice are recorded in Results."
                    : round.state === "VOIDED"
                      ? "No model conformed to the brief, so no points moved. Every stake was returned."
                      : round.state === "CANCELLED" || round.state === "FAILED"
                        ? "No render ran, so every stake is void and its points return to the pool."
                        : round.state === "RETRYING"
                          ? "A render or judge could not be reached, and the round is being retried rather than settled on a guess."
                          : "The round has locked. Renders are being produced, and the crowd vote opens once they land."}
              </p>
              <Link href="/results" className="btn btn-ghost btn-block mt-6">
                Results
              </Link>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
