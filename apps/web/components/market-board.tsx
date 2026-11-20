"use client";

import { useEffect, useMemo, useState } from "react";
import {
  PriceRibbon,
  modelInk,
  type PriceSample,
} from "@/components/price-ribbon";
import { Panel, Status, cx } from "@/components/ui";
import { computeDraftPricing, formatMultiplier } from "@/lib/odds";

/**
 * The market board (F9, drawn).
 *
 * A parimutuel pool has exactly two numbers worth watching, and this surface
 * shows both at once: **the implied chance** each model conforms (its share of
 * the money) and **the multiplier** you would be paid at if it does. One is a
 * price, the other is the payoff, and they move in opposite directions when you
 * buy — which is the thing a first-time visitor has to *see* rather than read.
 *
 * The draft stake is priced as if it landed this instant, replacing the viewer's
 * own holding rather than adding to it (`place_stake` upserts one conformance
 * stake per account per round). Every projected number on screen is labelled as
 * a what-if; nothing here claims the pool has actually moved.
 *
 * Truth constraints this surface inherits and does not relax:
 *
 *   * **Prices come from stakes only.** No render exists while staking is open,
 *     so nothing else can be allowed to pull a price around.
 *   * **No invented history and no invented market.** The ribbon draws only the
 *     observations this viewer witnessed, and an empty pool reads flat at zero
 *     rather than a tidy symmetric split.
 *   * **A quiet market still looks alive.** With no movement the bands breathe
 *     slowly; under `prefers-reduced-motion` they hold still. Motion never
 *     carries state on its own — every band is also a labelled row.
 */

const POLL_MS = 5_000;
const MAX_SAMPLES = 64;

export interface MarketModel {
  id: string;
  name: string;
}

export function MarketBoard({
  id,
  roundId,
  models,
  deadline,
  status,
  selectedModelId,
  points,
  onPick,
  className,
  variant = "panel",
}: {
  /** Anchor so the stake ticket can point a reader at the board. */
  id?: string;
  roundId: string;
  models: MarketModel[];
  deadline: string;
  status: string;
  /** The draft pick, lifted so the stake form and the board are one control. */
  selectedModelId: string | null;
  points: number;
  onPick: (modelId: string) => void;
  className?: string;
  /**
   * `panel` is the market page's board — chart, rows, the full reading.
   * `dock` is the live page's: the same prices compressed into a bar pinned to
   * the bottom of the viewport, so the crowd can watch the renders and read the
   * pool without choosing between them. It carries no chart and no draft, since
   * a locked round has neither.
   */
  variant?: "panel" | "dock";
}) {
  const [stakes, setStakes] = useState<Record<string, number> | null>(null);
  /**
   * The viewer's own conformance stake, when signed in.
   *
   * It is priced as a *replacement* in the draft: `place_stake` upserts one
   * stake per account per round, so a draft on the same model supersedes it and
   * a draft on another model moves it. Held here (not derived from `stakes`,
   * which is the anonymous aggregate) because only the caller's own row may be
   * read, and `stakes_by_model` deliberately does not reveal who is in it.
   */
  const [viewerStake, setViewerStake] = useState<{
    modelId: string;
    points: number;
  } | null>(null);
  const [samples, setSamples] = useState<PriceSample[]>([]);
  const [live, setLive] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const isOpen = status === "OPEN";

  // A round past OPEN still has a market worth reading: its pool is frozen and
  // the numbers are the final ones the settlement used. So the board reads once
  // and then stops — closed is not the same as absent.
  useEffect(() => {
    let active = true;

    async function read() {
      try {
        const response = await fetch(`/api/rounds/${roundId}/pool`, {
          cache: "no-store",
        });
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body?.error?.message ?? "Could not read the pool");
        }
        if (!active) return;
        const nextStakes = body.stakes_by_model as Record<string, number>;
        setStakes(nextStakes);
        setViewerStake(
          body.viewer_stake
            ? {
                modelId: body.viewer_stake.model_id,
                points: body.viewer_stake.points,
              }
            : null,
        );
        // Sample here, where the reading happened: the trace records what was
        // observed and when, and a poll that returns the same numbers adds
        // nothing (see `appendSample`).
        setSamples((previous) => appendSample(previous, nextStakes, models));
        setLive(true);
        setLoadError(null);
      } catch (error) {
        if (!active) return;
        // A failed poll does not blank the board; it stops claiming to be live.
        setLive(false);
        setLoadError(
          error instanceof Error ? error.message : "Could not read the pool",
        );
      }
    }

    void read();
    if (!isOpen) {
      return () => {
        active = false;
      };
    }

    const timer = setInterval(read, POLL_MS);
    // A backgrounded tab throttles timers; coming back should show the truth.
    const onVisible = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [roundId, isOpen, models]);

  // Record what the pool looked like, once per distinct reading. Bands only step
  // when the money actually changed; a poll that returns the same numbers must
  // not add a sample and make the trace look busy when it is not. Sampling
  // happens in the read itself (above), where `now` is the moment observed.
  const pricing = useMemo(
    () =>
      computeDraftPricing({
        models,
        stakesByModel: stakes ?? {},
        ownStake: isOpen ? viewerStake : null,
        // A closed market has no "if you send now": staking is over, so the
        // board quotes the pool as it was frozen, never a hypothetical.
        pickedModelId: isOpen ? (selectedModelId ?? null) : null,
        points,
      }),
    [models, stakes, isOpen, viewerStake, selectedModelId, points],
  );

  // What the draft changes, shown only where a draft actually exists.
  const drafting =
    isOpen && selectedModelId !== null && points > 0 && stakes !== null;
  const projectedShares = useMemo(
    () =>
      drafting
        ? pricing.models.map((model) =>
            pricing.pot > 0 ? model.staked / pricing.pot : 0,
          )
        : null,
    [drafting, pricing],
  );

  const standing = useMemo(() => {
    const total = stakes ? sum(stakes) : 0;
    return models.map((model) => {
      const staked = stakes?.[model.id] ?? 0;
      return total > 0 ? staked / total : 0;
    });
  }, [models, stakes]);

  const deadlineLabel = formatDeadline(deadline);

  if (variant === "dock") {
    return (
      <section
        id={id}
        aria-label={isOpen ? "The pool" : "The final pool"}
        className={cx(
          // Fixed: the pool is a reading you glance at while watching, so it has
          // to be there on the first frame and at every scroll position, not
          // only once the page happens to have scrolled past its slot. The page
          // reserves matching bottom padding so no content hides under it.
          "fixed inset-x-0 bottom-0 z-30 border-t border-hairline bg-void/85 backdrop-blur-xl",
          className,
        )}
      >
        <div className="shell flex flex-wrap items-center gap-x-6 gap-y-2 py-2.5 sm:py-3">
          <div className="flex w-full shrink-0 items-baseline justify-between gap-2.5 sm:w-auto sm:justify-start">
            <span className="flex items-baseline gap-2.5">
              <span className="t-label text-[0.5625rem] text-faint">
                {isOpen ? "The pool" : "Final pool"}
              </span>
              <span className="t-num text-[0.9375rem] text-ink">
                {pricing.pot.toLocaleString()}
                <span className="ml-1 text-[0.625rem] text-faint">pts</span>
              </span>
            </span>
            <span className="t-mono flex items-center gap-3 text-[0.5625rem] text-faint sm:hidden">
              {isOpen ? (
                <Status tone={live ? "live" : "idle"} pulse={live}>
                  {live ? "Live" : "Stalled"}
                </Status>
              ) : (
                <span className="sr-only">stakes closed</span>
              )}
            </span>
          </div>

          <span
            aria-hidden="true"
            className="hidden h-6 w-px bg-hairline sm:block"
          />

          {/* One line per model, in the same ink as its row on the board, so a
              viewer reading prices while the renders run can still tell which
              side is which without a legend. On a phone the three become three
              equal columns — a wrapped row gave each name a letter of room. */}
          <ul className="grid w-full min-w-0 flex-1 grid-cols-3 gap-x-3 gap-y-1 sm:flex sm:flex-wrap sm:items-center sm:gap-x-5">
            {pricing.models.map((model, index) => (
              <li
                key={model.modelId}
                className="flex min-w-0 items-center gap-x-2 sm:gap-2.5"
              >
                <span
                  aria-hidden="true"
                  className="size-[6px] shrink-0 rounded-full"
                  style={{ background: modelInk(index) }}
                />
                <span className="grid min-w-0 sm:flex sm:min-w-0 sm:items-center sm:gap-2.5">
                  <span className="block truncate text-[0.75rem] text-ink sm:text-[0.8125rem]">
                    {model.modelName}
                  </span>
                  <span className="flex items-baseline gap-2 sm:gap-2.5">
                    <span className="t-num whitespace-nowrap text-[0.625rem] text-muted sm:text-[0.6875rem]">
                      {model.staked.toLocaleString()}
                      <span className="ml-1 text-[0.5rem] text-faint sm:text-[0.5625rem]">
                        pts
                      </span>
                    </span>

                    <span
                      className={cx(
                        "t-num whitespace-nowrap text-[0.625rem] sm:text-[0.6875rem]",
                        model.multiplier === null ? "text-faint" : "text-ink",
                      )}
                    >
                      {formatMultiplier(model.multiplier)}
                    </span>
                  </span>
                </span>
              </li>
            ))}
          </ul>

          <div className="hidden shrink-0 items-center gap-3 sm:flex">
            <span className="t-mono text-[0.5625rem] text-faint">
              {isOpen ? "closes" : "stakes closed"} {deadlineLabel}
            </span>
            {isOpen ? (
              <Status tone={live ? "live" : "idle"} pulse={live}>
                {live ? "Live" : "Stalled"}
              </Status>
            ) : null}
          </div>
        </div>

        {loadError ? (
          <p
            role="status"
            className="t-mono border-t border-hairline px-5 py-1.5 text-center text-[0.5625rem] text-muted sm:px-8"
          >
            Lost the live pool — showing the last reading. Retrying…
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <Panel className={cx("overflow-hidden", className)} id={id}>
      {/* Instrument header: state, clock, and the live-feed dot. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-4">
        <div className="flex items-center gap-3">
          <span className="t-label text-[0.5625rem] text-faint">
            {isOpen ? "The pool" : "Final pool"}
          </span>
          <span aria-hidden="true" className="h-3 w-px bg-hairline" />
          <span className="t-num text-[0.8125rem] text-ink">
            {pricing.pot.toLocaleString()}
            <span className="ml-1 text-[0.625rem] text-faint">pts</span>
          </span>
          {drafting && pricing.points > 0 ? (
            <span className="t-mono text-[0.625rem] text-magenta">
              +{pricing.points} if sent
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <span className="t-mono hidden text-[0.625rem] text-faint sm:inline">
            {isOpen ? "closes" : "closed"} {deadlineLabel}
          </span>
          {isOpen ? (
            <Status tone={live ? "live" : "idle"} pulse={live}>
              {live ? "Live" : "Stalled"}
            </Status>
          ) : null}
        </div>
      </div>

      <div className="mt-3 px-2">
        <PriceRibbon
          models={models}
          samples={samples}
          projected={projectedShares}
          pickedModelId={selectedModelId}
          drafting={drafting}
          closed={!isOpen}
        />
      </div>

      {/* The three sides. Each row is a control: picking here is the same act as
          picking in the stake form, because the price on this row is the price
          you would be buying. */}
      <ul className="mt-1 px-3 pb-3">
        {pricing.models.map((model, index) => {
          const isPicked = model.modelId === selectedModelId;
          const before = standing[index] * 100;
          return (
            <li key={model.modelId}>
              <button
                type="button"
                onClick={() => onPick(model.modelId)}
                disabled={!isOpen}
                aria-pressed={isPicked}
                className={cx(
                  "group grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 rounded-xl border px-2.5 py-2.5 text-left transition-colors",
                  isPicked
                    ? "border-magenta/45 bg-magenta/[0.06]"
                    : "border-transparent",
                  isOpen &&
                    !isPicked &&
                    "hover:border-hairline hover:bg-white/[0.02]",
                  !isOpen && "cursor-default",
                )}
              >
                {/* Selection legible without colour: a filled pip vs a hollow one. */}
                <span
                  aria-hidden="true"
                  className={cx(
                    "grid size-[14px] place-items-center rounded-full border",
                    isPicked ? "border-magenta" : "border-white/25",
                  )}
                >
                  <span
                    className={cx(
                      "size-[6px] rounded-full",
                      isPicked ? "bg-magenta" : "bg-transparent",
                    )}
                  />
                </span>

                <span className="min-w-0">
                  <span className="block truncate text-[0.875rem] text-ink">
                    {model.modelName}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="t-mono text-[0.5625rem] text-faint">
                      {model.staked.toLocaleString()} pts
                    </span>
                    {isPicked && drafting && pricing.pickedDeltaPoints !== 0 ? (
                      <>
                        <span
                          className={cx(
                            "t-num whitespace-nowrap text-[0.5625rem]",
                            pricing.pickedDeltaPoints > 0
                              ? "text-magenta"
                              : "text-muted",
                          )}
                        >
                          {pricing.pickedDeltaPoints > 0 ? "+" : ""}
                          {pricing.pickedDeltaPoints.toFixed(2)} pp
                        </span>
                        {/* The other half of the trade, always negative: your own
                            money shares the same pot with itself. Hidden on a
                            phone, where one honest number per row is enough. */}
                        {pricing.pickedDeltaMultiplier !== null &&
                        pricing.pickedDeltaMultiplier !== 0 ? (
                          <span className="t-num hidden whitespace-nowrap text-[0.5625rem] text-muted sm:inline">
                            {pricing.pickedDeltaMultiplier.toFixed(2)}× payout
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </span>
                </span>

                {/* Only the payout. The implied chance is already drawn twice
                    on this row — the bar under it and the line on the chart —
                    and stating it a third time as a percentage made a parimutuel
                    price read like a forecast of the render. */}
                <span className="flex w-[3.6rem] shrink-0 flex-col items-end gap-1">
                  <span className="t-label text-[0.5rem] text-faint">
                    payout
                  </span>
                  <span
                    className={cx(
                      "t-num whitespace-nowrap text-[0.8125rem] leading-none",
                      model.multiplier === null ? "text-faint" : "text-muted",
                    )}
                  >
                    {formatMultiplier(model.multiplier)}
                  </span>
                </span>
              </button>

              {/* The money's own bar, in this model's line ink, so a row and
                  its trace are the same object. The picked row's bar is the
                  accent and its ghost shows where the price stood before the
                  draft — a buy is the two edges separating. */}
              <div className="relative mx-2.5 mb-1 mt-1 h-[3px] overflow-hidden rounded-full bg-white/[0.05]">
                {isPicked && drafting ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 rounded-full bg-white/25 transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
                    style={{ width: `${clampPct(before)}%` }}
                  />
                ) : null}
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
                  style={{
                    width: `${clampPct(model.percent)}%`,
                    background: isPicked
                      ? "linear-gradient(90deg, var(--magenta-deep), var(--magenta))"
                      : modelInk(index),
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-hairline px-5 py-2.5">
        <p className="t-mono text-[0.5625rem] leading-relaxed text-faint">
          {!isOpen
            ? "the pool as it closed — the split settlement used"
            : stakes && sum(stakes) > 0
              ? "chance = share of the pot · payout = pot ÷ its backers"
              : "no stakes yet — the market opens with the first stake"}
        </p>
        {drafting && pricing.pickedPercent !== null ? (
          <p className="t-mono text-[0.5625rem] text-magenta/80">
            dashed = if you send now
          </p>
        ) : null}
      </div>

      {loadError ? (
        <p
          role="status"
          className="t-mono border-t border-hairline px-5 py-2 text-[0.5625rem] text-muted"
        >
          Lost the live pool — showing the last reading. Retrying…
        </p>
      ) : null}
    </Panel>
  );
}

function sum(record: Record<string, number>): number {
  let total = 0;
  for (const value of Object.values(record)) {
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

/**
 * Append a reading to the trace, unless it says the same thing as the last one.
 *
 * The pool is a step function: between stakes the shares are identical, and
 * recording those identical readings would make an idle market's trace look
 * busy and stretch its time axis with nothing in it.
 */
function appendSample(
  previous: ReadonlyArray<PriceSample>,
  stakesByModel: Record<string, number>,
  models: ReadonlyArray<{ id: string }>,
): PriceSample[] {
  const total = sum(stakesByModel);
  const shares = models.map((model) =>
    total > 0 ? (stakesByModel[model.id] ?? 0) / total : 0,
  );
  const last = previous[previous.length - 1];
  if (
    last &&
    last.shares.length === shares.length &&
    last.shares.every((value, index) => Math.abs(value - shares[index]) < 1e-6)
  ) {
    return previous as PriceSample[];
  }
  return [...previous, { at: Date.now(), shares }].slice(-MAX_SAMPLES);
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** A compact absolute deadline: `Nov 22, 00:48 UTC`. */
function formatDeadline(deadline: string): string {
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}
