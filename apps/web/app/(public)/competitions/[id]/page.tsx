"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CountdownReadout } from "@/components/countdown";
import { LiveRoundPanel } from "@/components/live-round-panel";
import { MarketBoard } from "@/components/market-board";
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

  // The stake's ceiling is a display convenience (the ledger is the real limit);
  // the slider needs a max, and 1,000 is a round number a person can reason about.
  // The floor mirrors `MIN_STAKE_POINTS` in the stakes service, which is
  // `server-only` and cannot be imported into this client component.
  const MIN_STAKE = 10;
  const MAX_STAKE = 1000;
  const selectedModel = round.models.find((m) => m.id === selected) ?? null;
  const sliderValue = Math.max(
    MIN_STAKE,
    Math.min(MAX_STAKE, Number(stake) || MIN_STAKE),
  );
  const sliderFill = Math.round(
    ((sliderValue - MIN_STAKE) / (MAX_STAKE - MIN_STAKE)) * 100,
  );

  // Two clocks, two layouts. While staking is open the page is a market: title,
  // brief and the pool. Once the round locks the page is the show — the renders
  // take the page's full width and the pool becomes a dock that follows the
  // scroll, because the crowd reads prices while watching, not after.
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
          ? "No model conformed to the brief, so no points moved. Every stake was returned."
          : round.state === "CANCELLED" || round.state === "FAILED"
            ? "No render ran, so every stake is void and its points return to the pool."
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
        <>
          <p className="t-body mt-4 max-w-[76ch] text-[0.8125rem] text-muted">
            {liveNote}
          </p>

          {/* The show takes the page's full width: three renders side by side is
              the product's promise, and it only reads when they have the room. */}
          <LiveRoundPanel
            roundId={round.id}
            initialStatus={round.state}
            className="mt-5"
          />

          {/* The pool is pinned to the bottom edge: the stakes and payouts stay
              in view at every scroll position without taking the stage. */}
          <MarketBoard
            variant="dock"
            roundId={round.id}
            models={round.models}
            deadline={round.deadline}
            status={round.state}
            selectedModelId={null}
            points={0}
            onPick={() => {}}
          />
        </>
      ) : (
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:items-start">
          <div className="min-w-0 space-y-3">
            {/* The pool as a live instrument: the price you would buy at, and
                the three weights it is made of. It is the same control as the
                stake form — a row here and a row there are one selection. */}
            <MarketBoard
              id="market-board"
              roundId={round.id}
              models={round.models}
              deadline={round.deadline}
              status={round.state}
              selectedModelId={selected || null}
              points={Number(stake)}
              onPick={setSelected}
            />

            <p className="t-body px-1 text-xs text-faint">
              Points, not money. Every stake on a round is one pot; when the
              round settles, it is split pro-rata among the backers of the model
              that conforms to the brief — and a model nobody backed pays
              nobody.
            </p>
          </div>

          <div className="min-w-0 space-y-3 lg:sticky lg:top-24">
            {/* This column only exists while staking is open — a locked round
                renders the live page instead — so the ticket is either a form
                or the receipt for a stake already sealed. */}
            <Panel className="p-7">
              {!staked ? (
                <form onSubmit={handleSubmit}>
                  <div className="flex items-center justify-between">
                    <h2 className="t-title text-[1rem] text-ink">
                      Seal a stake
                    </h2>
                    <span className="t-mono text-[0.625rem] text-faint">
                      before{" "}
                      {deadline.text === "Locked" ? "lock" : deadline.text}
                    </span>
                  </div>

                  {/* Which side the ticket sits on, echoing the board's
                      selection. */}
                  <div className="mt-5">
                    <p className="t-label text-[0.5625rem] text-faint">
                      Which model conforms?
                    </p>
                    {selectedModel ? (
                      <div className="mt-2.5 flex items-center justify-between gap-3 rounded-xl border border-magenta/45 bg-magenta/[0.06] px-4 py-3">
                        <span className="flex items-center gap-3">
                          <span
                            aria-hidden="true"
                            className="grid size-[15px] shrink-0 place-items-center rounded-full border border-magenta"
                          >
                            <span className="size-[7px] rounded-full bg-magenta" />
                          </span>
                          <span className="text-[0.875rem] text-ink">
                            {selectedModel.name}
                          </span>
                        </span>
                        <span className="t-mono text-[0.625rem] text-faint">
                          priced above
                        </span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          document
                            .getElementById("market-board")
                            ?.scrollIntoView({
                              behavior: "smooth",
                              block: "center",
                            })
                        }
                        className="mt-2.5 w-full rounded-xl border border-dashed border-[var(--control-line)] px-4 py-3 text-left text-[0.8125rem] text-muted transition-colors hover:border-white/45 hover:text-ink"
                      >
                        Pick a side on the pool above to price this stake
                      </button>
                    )}
                  </div>

                  <div className="mt-5">
                    <div className="flex items-baseline justify-between gap-2">
                      <label
                        htmlFor="stake"
                        className="t-label text-[0.5625rem] text-faint"
                      >
                        Stake
                      </label>
                      <span className="t-mono text-[0.5625rem] text-faint">
                        range {MIN_STAKE}–{MAX_STAKE.toLocaleString()}
                      </span>
                    </div>

                    {/* Slider and field are one control: the slider for feel,
                        the field for an exact number. */}
                    <div className="mt-2.5 flex items-center gap-3">
                      <div className="field flex flex-1 items-center gap-3 py-2">
                        <input
                          type="range"
                          min={MIN_STAKE}
                          max={MAX_STAKE}
                          step={10}
                          value={sliderValue}
                          onChange={(e) => setStake(e.target.value)}
                          aria-label="Stake amount"
                          aria-describedby="stake-hint"
                          className="stake-range"
                          style={
                            {
                              "--fill": `${sliderFill}%`,
                            } as React.CSSProperties
                          }
                        />
                        <input
                          id="stake"
                          type="number"
                          min={MIN_STAKE}
                          step={10}
                          value={stake}
                          onChange={(e) => setStake(e.target.value)}
                          aria-describedby="stake-hint"
                          className="t-num w-[4.5rem] shrink-0 border-0 bg-transparent text-right text-[0.9375rem] text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </div>
                      <span className="t-mono shrink-0 text-[0.6875rem] text-faint">
                        pts
                      </span>
                    </div>
                    <p
                      id="stake-hint"
                      className="t-mono mt-2 text-[0.625rem] text-faint"
                    >
                      minimum {MIN_STAKE} points · one stake per round · you can
                      raise it until the deadline
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
                    disabled={saving || !selected || Number(stake) < MIN_STAKE}
                    className="btn btn-solid btn-block mt-6"
                  >
                    {saving
                      ? "Sealing…"
                      : selectedModel
                        ? `Seal ${Number(stake).toLocaleString()} on ${selectedModel.name}`
                        : "Seal this stake"}
                  </button>

                  <p className="t-mono mt-3 text-center text-[0.625rem] leading-relaxed text-faint">
                    committed on devnet as hash(pick, stake, nonce)
                  </p>
                </form>
              ) : (
                <div className="text-center">
                  <Status tone="ink">Sealed</Status>
                  <p className="t-title mt-5 text-lg text-ink">
                    Your stake is in the pool.
                  </p>
                  {round.user_stake ? (
                    <p className="t-num mt-2 text-[0.8125rem] text-muted">
                      {round.user_stake.points.toLocaleString()} pts on{" "}
                      <span className="text-ink">
                        {round.models.find(
                          (m) => m.id === round.user_stake?.model_id,
                        )?.name ?? "a contender"}
                      </span>
                    </p>
                  ) : null}
                  <p className="t-body mt-2 text-sm text-muted">
                    It is locked for this round, and settles with the pool once
                    the round settles.
                  </p>
                  <Link
                    href="/predictions"
                    className="btn btn-ghost btn-block mt-6"
                  >
                    My predictions
                  </Link>
                </div>
              )}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
