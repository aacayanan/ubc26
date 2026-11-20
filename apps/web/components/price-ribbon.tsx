"use client";

import { cx } from "@/components/ui";

/**
 * The market's price history: one line per model, 0–100%, drawn as it actually
 * moved. (F9's odds, made watchable.)
 *
 * The pot pays exactly one model, so a model's share of the pot is the market's
 * implied chance that it is that one — the lines sum to 100% at every instant.
 * A stake landing is therefore visible twice: one line steps up, the others step
 * down, and every multiplier moves the other way. That reciprocity is the whole
 * point of the surface, which is why this is a price chart and not a bar chart.
 *
 * Four rules keep it honest:
 *
 *   * **Only observed readings are drawn.** The trace begins wherever this
 *     viewer started watching, flat, because nothing before that was witnessed.
 *     There is no backfilled history: publishing a per-stake timeline would
 *     disclose which model strangers backed, which the product does not.
 *   * **The right-hand strip is never a forecast.** It is a dashed projection of
 *     what the lines would read the instant the draft stake landed, labelled
 *     "if you send now", and it exists only while a draft does.
 *   * **Steps, not splines.** Prices move in discrete events; smoothing them
 *     would imply continuous trading that did not happen.
 *   * **Identity is ink weight, never a third hue.** The palette has one live
 *     accent and it belongs to selection and the now line.
 *
 * An empty pool draws nothing but the grid: a made-up even split would be a
 * market opinion nobody actually expressed.
 */

export interface PriceSample {
  /** Epoch ms of the observation. */
  at: number;
  /** Share of the pot per model, 0..1, in the caller's model order. */
  shares: number[];
}

const VIEW_W = 1000;
const VIEW_H = 100;
/** Width of the "if you send now" strip beyond the now line. */
const GHOST_W = 96;
const GRID = [0, 0.25, 0.5, 0.75, 1];
/**
 * Vertical inset so a line at 0% or 100% is not clipped by the frame edge.
 * A one-sided market is a real reading — a model nobody backed, or the only
 * backed model — and it has to be visible, not pressed flat against the border.
 */
const PAD = 2;

/**
 * One ink code for the whole board: a model's line in the chart, and the bar
 * under its row, are the same weight of pale ink. Selection is the one thing
 * that takes the accent. This is how a reader maps a line to a model without a
 * legend — and without spending a third hue on the page.
 *
 * The faintest step is 0.42, not lower: on the void ground a heavier alpha is
 * the only way to clear the 3:1 non-text contrast floor, and a line nobody can
 * see has no identity to bind.
 */
export const MODEL_INK = [0.9, 0.62, 0.42] as const;

/** The same code as a paint string, for anything outside this SVG. */
export function modelInk(index: number): string {
  return `rgb(243 239 247 / ${MODEL_INK[index] ?? MODEL_INK[2]})`;
}

export function PriceRibbon({
  models,
  samples,
  projected,
  pickedModelId,
  drafting,
  closed = false,
  className,
}: {
  models: ReadonlyArray<{ id: string; name: string }>;
  samples: ReadonlyArray<PriceSample>;
  /** Shares as they would read after the draft stake, or null when not drafting. */
  projected: number[] | null;
  pickedModelId: string | null;
  drafting: boolean;
  /** A settled market is a record, not a live feed: the now line stops breathing. */
  closed?: boolean;
  className?: string;
}) {
  const width = VIEW_W + GHOST_W;

  // One reading still has to occupy the frame: draw it as what it has been,
  // flat, from where the observations start to now.
  const points =
    samples.length === 0
      ? [{ at: 0, shares: models.map(() => 0) }]
      : samples.length === 1
        ? [samples[0], samples[0]]
        : samples;
  const xs = points.map((_, index) =>
    points.length <= 1 ? 0 : (index / (points.length - 1)) * VIEW_W,
  );

  const hasMoney = points.some((sample) =>
    sample.shares.some((value) => value > 0),
  );
  const lastAt = samples[samples.length - 1]?.at ?? 0;
  const span = lastAt - (samples[0]?.at ?? 0);

  return (
    <div className={cx("relative pb-1 pl-7", className)}>
      <div className="relative">
        <svg
        viewBox={`0 0 ${width} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="block h-[108px] w-full sm:h-[124px]"
        role="img"
        aria-label={
          hasMoney
            ? `Implied chance of conforming for each model, over the last ${formatSpan(span)}: ${models
                .map(
                  (model, index) =>
                    `${model.name} ${Math.round((points[points.length - 1]?.shares[index] ?? 0) * 100)} percent`,
                )
                .join(", ")}.${drafting ? " A draft stake is shown as a dashed projection." : ""}`
            : "No stakes have been placed yet, so the market has no prices to draw."
        }
      >
        {/* Reserved projection strip, so a draft never shifts the frame. */}
        <rect
          x={VIEW_W}
          y={0}
          width={GHOST_W}
          height={VIEW_H}
          fill="rgb(255 255 255 / 0.016)"
        />

        {GRID.map((value) => (
          <line
            key={value}
            x1={0}
            y1={y(value)}
            x2={width}
            y2={y(value)}
            stroke="rgb(255 255 255 / 0.06)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* The bar the market is measured against: equally likely, so an even
            split reads as the neutral it is. Only a real three-way lineup has
            one — two models or five would make this line a lie. */}
        {models.length === 3 ? (
          <line
            x1={0}
            y1={y(1 / 3)}
            x2={width}
            y2={y(1 / 3)}
            stroke="rgb(255 255 255 / 0.14)"
            strokeWidth={1}
            strokeDasharray="1 3"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* The lines. Drawn last-to-first so the leading model sits on top. */}
        <g className={hasMoney && !closed ? "price-trace" : undefined}>
          {models
            .map((model, index) => {
              const ys = points.map((sample) =>
                y(clamp01(sample.shares[index] ?? 0)),
              );
              const isPicked = model.id === pickedModelId;
              return { model, index, ys, isPicked };
            })
            .reverse()
            .map(({ model, index, ys, isPicked }) => (
              <g key={model.id}>
                <path
                  d={stepPath(ys, xs)}
                  fill="none"
                  stroke={isPicked ? "var(--magenta)" : modelInk(index)}
                  strokeWidth={isPicked ? 1.8 : 1.4}
                  strokeLinejoin="miter"
                  vectorEffect="non-scaling-stroke"
                />
                {/* The head: where the price stands now. */}
                <circle
                  cx={VIEW_W}
                  cy={ys[ys.length - 1]}
                  r={2}
                  fill={isPicked ? "var(--magenta)" : modelInk(index)}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}
        </g>

        {/* The draft: where each line would land, dashed, in the reserved strip. */}
        {projected
          ? projected.map((share, index) => {
              const from = y(clamp01(points[points.length - 1]?.shares[index] ?? 0));
              const to = y(clamp01(share));
              const isPicked = models[index]?.id === pickedModelId;
              return (
                <g key={`projected-${models[index]?.id ?? index}`}>
                  <line
                    x1={VIEW_W}
                    y1={from}
                    x2={VIEW_W}
                    y2={to}
                    stroke={
                      isPicked ? "rgb(255 46 147 / 0.5)" : "rgb(255 255 255 / 0.18)"
                    }
                    strokeWidth={1}
                    strokeDasharray="2 2"
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={VIEW_W}
                    y1={to}
                    x2={width}
                    y2={to}
                    stroke={
                      isPicked ? "rgb(255 46 147 / 0.85)" : "rgb(255 255 255 / 0.34)"
                    }
                    strokeWidth={isPicked ? 1.4 : 1}
                    strokeDasharray="3 3"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })
          : null}

        {/* Now — or, on a closed market, the line the clock stopped at. */}
        <line
          x1={VIEW_W}
          y1={0}
          x2={VIEW_W}
          y2={VIEW_H}
          stroke={closed ? "rgb(255 255 255 / 0.22)" : "rgb(255 46 147 / 0.5)"}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          className={
            closed ? undefined : drafting ? "now-line now-line-active" : "now-line"
          }
        />
      </svg>

      {/* Axis labels sit outside the scaled viewBox so type keeps its shape. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between"
      >
        {[100, 75, 50, 25, 0].map((value) => (
          <span
            key={value}
            className="t-num text-[0.5rem] leading-none text-faint/70"
          >
            {value}
          </span>
        ))}
      </div>

      {/* With no money in the pool there is no price. Said on the chart, in real
          type, rather than left for the reader to infer from three flat lines. */}
      {!hasMoney ? (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-8 text-center">
          <span className="t-label bg-void/70 px-2 text-[0.5rem] text-faint backdrop-blur-[2px]">
            no stakes yet — prices open with the first one
          </span>
        </p>
      ) : null}
      </div>

      <div className="mt-2 flex items-center justify-between">
        <span className="t-label text-[0.5rem] text-faint">
          {closed
            ? "final reading"
            : samples.length < 2
              ? "watching the pool"
              : `last ${formatSpan(span)}`}
        </span>
        <span className="t-label hidden text-[0.5rem] text-faint sm:inline">
          share of pool · %
        </span>
        <span
          className={cx(
            "t-label text-[0.5rem]",
            closed ? "text-faint" : "text-magenta/70",
          )}
        >
          {closed ? "closed" : "now"}
        </span>
      </div>
    </div>
  );
}

/** A step path: horizontal runs joined by vertical jumps at each reading. */
function stepPath(ys: number[], xs: number[]): string {
  if (ys.length === 0) return "";
  let d = `M${xs[0]},${ys[0]}`;
  for (let index = 1; index < ys.length; index += 1) {
    d += ` L${xs[index]},${ys[index - 1]} L${xs[index]},${ys[index]}`;
  }
  d += ` L${xs[xs.length - 1]},${ys[ys.length - 1]}`;
  return d;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Share 0..1 → a y inside the padded frame. */
function y(share: number): number {
  return PAD + (VIEW_H - PAD * 2) * (1 - clamp01(share));
}

/** How much of the pool's life this trace covers: `4m`, `1h 20m`, `2d`. */
function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "<1m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
