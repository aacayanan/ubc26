"use client";

import { useMemo } from "react";
import {
  PriceRibbon,
  modelInk,
  type PriceSample,
} from "@/components/price-ribbon";
import { Panel, cx } from "@/components/ui";
import { formatMultiplier } from "@/lib/odds";
import { formatSol, parseSolToLamports } from "@/lib/sol-pool";

/**
 * The market board (SOL, drawn).
 *
 * A parimutuel pool has exactly two numbers worth watching, and this surface
 * shows both at once: **the implied chance** each model conforms (its share of
 * the money) and **the multiplier** you would be paid at if it does. One is a
 * price, the other is the payoff, and they move in opposite directions when you
 * buy — which is the thing a first-time visitor has to *see* rather than read.
 *
 * This is the F9 market board, restored after the SOL pivot dropped it. The
 * price trace is the same instrument; the ticket beneath it is now a slider
 * instead of a text field, because the amount is the thing a bettor fiddles
 * with and a slider makes the cost legible while the projection redraws under
 * the thumb.
 *
 * Truth constraints this surface inherits and does not relax:
 *
 *   * **Prices come from wagers only.** No render exists while betting is open,
 *     so nothing else can be allowed to pull a price around.
 *   * **No invented history and no invented market.** The ribbon draws only the
 *     observations this viewer witnessed, and an empty pool reads flat at zero
 *     rather than a tidy symmetric split.
 *   * **Every projection is labelled.** The dashed strip is "if you send now";
 *     the pool has not moved until the wager is accepted on Devnet.
 *   * **A live wager adds.** Unlike the retired points stake (which upserted one
 *     row per account), a SOL wager joins the pool alongside the ante, so the
 *     projection is additive, not a replacement.
 */

const MAX_SAMPLES = 64;

export interface BoardModel {
  id: string;
  name: string;
}

export interface BoardPool {
  bettingPhase: "ante" | "live" | "closed";
  final: boolean;
  grossLamports: string;
  feeBps: number;
  pendingWagers: number;
  models: Array<{
    modelId: string;
    stakedLamports: string;
    share: number;
    multiplier: number | null;
  }>;
}

export function SolMarketBoard({
  models,
  pool,
  selected,
  onSelect,
  amount,
  onAmount,
  /** Observed price readings; the parent records one per poll. */
  samples,
  /** The $3 live floor in SOL at the reference price, from the pool API. */
  minimum,
  drafting,
  ante = false,
  busy,
  busyLabel,
  onSubmit,
  ctaLabel,
  anteNote,
  className,
}: {
  models: ReadonlyArray<BoardModel>;
  pool: BoardPool;
  selected: string;
  onSelect: (modelId: string) => void;
  /** The live wager amount in SOL, as text. Ignored while `drafting` is false. */
  amount: string;
  onAmount: (value: string) => void;
  /** Observed price readings; the parent records one per poll. */
  samples: ReadonlyArray<PriceSample>;
  /** The $3 live floor in SOL at the reference price (pool API), for the hint. */
  minimum: { usdCents: number; sol: string } | null;
  /** True when a live wager ticket should be shown. */
  drafting: boolean;
  /** True when the ticket is the fixed tier-priced ante instead of a live one. */
  ante?: boolean;
  busy: boolean;
  /** What the button says while a signature is in flight. */
  busyLabel?: string;
  onSubmit: () => void;
  ctaLabel: string;
  /** One line under the ante button; ignored on a live ticket. */
  anteNote?: string;
  className?: string;
}) {
  const closed = pool.bettingPhase === "closed";

  // A live wager is priced in dollars ($3 minimum), not in a fixed SOL range:
  // the server enforces `minLiveUsdCents` at prepare and the round has no
  // maximum, so the ticket floors at the quoted minimum and otherwise takes
  // whatever the bettor types. A blank amount means "the minimum" — the same
  // default the prepare call uses.
  const minSol = minimum ? Number(minimum.sol) : 0;
  const parsed = Number(amount.trim());
  const amountSol =
    amount.trim() !== "" && Number.isFinite(parsed) && parsed > 0
      ? parsed
      : minSol;

  const draftLamports = useMemo(() => {
    try {
      return parseSolToLamports(amountSol.toFixed(3));
    } catch {
      return BigInt(0);
    }
  }, [amountSol]);

  // Shares as they would read the instant the draft landed. Additive: the wager
  // joins the pool beside the ante and any earlier live wagers.
  const projected = useMemo(() => {
    if (!drafting || closed || draftLamports <= BigInt(0)) return null;
    const gross = BigInt(pool.grossLamports);
    const total = gross + draftLamports;
    if (total <= BigInt(0)) return null;
    return models.map((model) => {
      const entry = pool.models.find((m) => m.modelId === model.id);
      const base = BigInt(entry?.stakedLamports ?? "0");
      const add = model.id === selected ? draftLamports : BigInt(0);
      return Number(base + add) / Number(total);
    });
  }, [drafting, closed, draftLamports, pool, models, selected]);

  const byModel = useMemo(
    () => new Map(pool.models.map((m) => [m.modelId, m])),
    [pool.models],
  );

  const hasMoney = pool.models.some(
    (m) => BigInt(m.stakedLamports) > BigInt(0),
  );
  const canSubmit =
    drafting && !closed && !busy && Boolean(selected) && draftLamports > 0;

  return (
    <Panel className={cx("overflow-hidden", className)}>
      {/* Instrument header: what this is, and how much is riding on it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-4">
        <div className="flex items-center gap-3">
          <span className="t-label text-[0.5625rem] text-faint">
            {closed ? "Final pool" : "The pool"}
          </span>
          <span aria-hidden="true" className="h-3 w-px bg-hairline" />
          <span className="t-num text-[0.8125rem] text-ink">
            {formatSol(BigInt(pool.grossLamports))}
            <span className="ml-1 text-[0.625rem] text-faint">SOL</span>
          </span>
          {pool.pendingWagers > 0 ? (
            <span className="t-mono text-[0.625rem] text-faint">
              {pool.pendingWagers} confirming
            </span>
          ) : null}
        </div>
        <span className="t-mono text-[0.625rem] text-faint">
          % of pool = implied chance it conforms
        </span>
      </div>

      <div className="mt-3 px-2">
        <PriceRibbon
          models={models}
          samples={samples}
          projected={projected}
          pickedModelId={selected || null}
          drafting={Boolean(projected)}
          closed={closed}
        />
      </div>

      {/* The sides. Each row is a control: picking here is the same act as
          picking on the chart, because the price on this row is the price you
          would be buying. */}
      <fieldset disabled={closed || busy} className="mt-1 px-3 pb-3">
        <legend className="sr-only">Which model conforms?</legend>
        <ul className="space-y-0.5">
          {models.map((model, index) => {
            const entry = byModel.get(model.id);
            const isPicked = model.id === selected;
            const share = entry?.share ?? 0;
            return (
              <li key={model.id}>
                <label
                  className={cx(
                    "group flex cursor-pointer items-center gap-3 rounded-xl border px-2.5 py-2.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet",
                    isPicked
                      ? "border-magenta/45 bg-magenta/[0.06]"
                      : "border-transparent",
                    !closed &&
                      !isPicked &&
                      "hover:border-hairline hover:bg-white/[0.02]",
                    closed && "cursor-default",
                  )}
                >
                  <input
                    type="radio"
                    name="sol-market-model"
                    value={model.id}
                    checked={isPicked}
                    onChange={() => onSelect(model.id)}
                    className="sr-only"
                  />
                  {/* Selection legible without colour: a filled pip vs a hollow one. */}
                  <span
                    aria-hidden="true"
                    className={cx(
                      "grid size-[14px] shrink-0 place-items-center rounded-full border",
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

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.875rem] text-ink">
                      {model.name}
                    </span>
                    <span className="mt-1 block h-[2px] w-full overflow-hidden rounded-full bg-white/[0.05]">
                      <span
                        aria-hidden="true"
                        className="block h-full rounded-full transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
                        style={{
                          width: `${Math.max(0, Math.min(1, share)) * 100}%`,
                          background: isPicked
                            ? "var(--magenta)"
                            : modelInk(index),
                        }}
                      />
                    </span>
                  </span>

                  <span className="flex shrink-0 items-baseline gap-3">
                    <span className="flex flex-col items-end gap-1">
                      <span className="t-label text-[0.5rem] text-faint">
                        payout
                      </span>
                      <span
                        className={cx(
                          "t-num whitespace-nowrap text-[0.8125rem] leading-none",
                          entry?.multiplier === null ||
                            entry?.multiplier === undefined
                            ? "text-faint"
                            : "text-muted",
                        )}
                      >
                        {formatMultiplier(entry?.multiplier ?? null)}
                      </span>
                    </span>
                    {/* Labelled, not a bare number: this is the share of the
                        pool staked on this model, which is the market's implied
                        chance that it conforms. It reads beside `payout` so the
                        two prices are the same kind of object — what it is
                        worth and what it would pay — rather than one labelled
                        figure and one free-floating percentage. */}
                    <span className="flex flex-col items-end gap-1">
                      <span className="t-label text-[0.5rem] text-faint">
                        chance
                      </span>
                      {/* `chance` is shorthand for the header's fuller
                          "share of the pool (the crowd's implied chance)". */}
                      <span className="t-num flex h-[1.6rem] w-[2.9rem] shrink-0 items-baseline justify-center gap-px rounded-lg border border-hairline bg-white/[0.03] pt-[0.28rem] text-[0.9375rem] leading-none text-ink">
                        {(share * 100).toFixed(0)}
                        <span className="text-[0.625rem] text-faint">%</span>
                      </span>
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {/* The ticket: a plain amount field. The stake is priced in dollars, so
          a range would have to chase the SOL/USD quote — a text entry with the
          quoted minimum as its floor matches what prepare() enforces, and the
          projection above still redraws as the bettor types. */}
      {ante && !closed ? (
        <div className="border-t border-hairline px-5 py-4">
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !selected}
            className="btn btn-solid btn-block"
          >
            {busy ? (busyLabel ?? "Signing…") : ctaLabel}
          </button>
          {anteNote ? (
            <p className="t-mono mt-2 text-center text-[0.5625rem] text-faint">
              {anteNote}
            </p>
          ) : null}
        </div>
      ) : drafting && !closed ? (
        <div className="border-t border-hairline px-5 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <label
              htmlFor="sol-stake"
              className="t-label text-[0.5625rem] text-faint"
            >
              Stake
            </label>
            <span className="t-num text-[1.0625rem] leading-none text-ink">
              {amountSol.toFixed(3)}
              <span className="ml-1 text-[0.625rem] text-faint">SOL</span>
            </span>
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            <input
              id="sol-stake"
              inputMode="decimal"
              value={amount}
              placeholder={minimum ? minimum.sol : undefined}
              onChange={(event) => onAmount(event.target.value)}
              aria-describedby="sol-stake-hint"
              disabled={busy}
              className="field t-num"
            />
            <span className="t-mono shrink-0 text-[0.6875rem] text-faint">
              SOL
            </span>
          </div>
          <p
            id="sol-stake-hint"
            className="t-mono mt-2 text-[0.5625rem] text-faint"
          >
            minimum ${(minimum ? minimum.usdCents : 300) / 100}
            {minimum ? ` (≈ ${minimum.sol} SOL now)` : ""} · no maximum · up to
            10 live wagers per round
          </p>

          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="btn btn-solid btn-block mt-4"
          >
            {busy ? (busyLabel ?? "Signing…") : ctaLabel}
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-hairline px-5 py-2.5">
        <p className="t-mono text-[0.5625rem] leading-relaxed text-faint">
          {closed
            ? "the pool as it closed — the split settlement used"
            : hasMoney
              ? "chance = share of the pot · payout = net pot ÷ its backers"
              : "no wagers yet — the market opens with the first one"}
        </p>
        {projected ? (
          <p className="t-mono text-[0.5625rem] text-magenta/80">
            dashed = if you send now
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * Append a reading to the trace, unless it says the same thing as the last one.
 *
 * The pool is a step function: between wagers the shares are identical, and
 * recording those identical readings would make an idle market's trace look
 * busy and stretch its time axis with nothing in it. Returning the previous
 * array (same reference) also lets React skip the re-render.
 */
export function appendPriceSample(
  previous: ReadonlyArray<PriceSample>,
  pool: BoardPool,
  models: ReadonlyArray<BoardModel>,
): PriceSample[] {
  const gross = BigInt(pool.grossLamports);
  const shares = models.map((model) => {
    const entry = pool.models.find((m) => m.modelId === model.id);
    const staked = BigInt(entry?.stakedLamports ?? "0");
    return gross > BigInt(0) ? Number(staked) / Number(gross) : 0;
  });
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
