import type { ReactNode } from "react";

export function cx(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ *
 * Surfaces
 * ------------------------------------------------------------------ */

export function Panel({
  children,
  className,
  quiet = false,
  interactive = false,
  id,
}: {
  children: ReactNode;
  className?: string;
  quiet?: boolean;
  interactive?: boolean;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={cx(
        quiet ? "panel-quiet" : "panel",
        interactive && "panel-interactive",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Status — a 6px dot and a word, never a filled neon chip.
 * ------------------------------------------------------------------ */

type Tone = "live" | "violet" | "ink" | "amber" | "idle";

const toneClass: Record<Tone, string> = {
  live: "dot-live",
  violet: "dot-violet",
  ink: "dot-ink",
  amber: "dot-amber",
  idle: "dot-idle",
};

export function Status({
  tone = "idle",
  pulse = false,
  children,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx("status", className)}>
      <span
        aria-hidden="true"
        className={cx("dot", toneClass[tone], pulse && "dot-pulse")}
      />
      {children}
    </span>
  );
}

/** Map a round state to the accent that carries it. */
export function roundTone(state: string): Tone {
  switch (state) {
    case "OPEN":
      return "live";
    case "LOCKED":
    case "RUNNING":
    case "EVALUATING":
      return "violet";
    case "SETTLED":
      return "ink";
    case "VOIDED":
      // A void is an honest non-result, not a failure of the show (F15).
      return "amber";
    default:
      return "idle";
  }
}

export function roundLabel(state: string): string {
  switch (state) {
    case "OPEN":
      return "Staking open";
    case "LOCKED":
      return "Locked";
    case "RUNNING":
      return "Rendering";
    case "EVALUATING":
      // The pipeline produces verdicts and stops here; settlement is a separate
      // step (F18). Labelling this "Judging" made a finished round look busy when
      // it was only waiting to settle. The judge has already ruled by this state.
      return "Awaiting settlement";
    case "SETTLED":
      return "Settled";
    case "VOIDED":
      return "Void";
    case "ARCHIVED":
      return "Archived";
    case "CANCELLED":
      return "Cancelled";
    case "FAILED":
      return "Failed";
    case "RETRYING":
      return "Retrying";
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ *
 * Meter
 * ------------------------------------------------------------------ */

export function Meter({
  value,
  className,
  label,
}: {
  value: number;
  className?: string;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={cx("meter", className)}
      role="img"
      aria-label={label ?? `${Math.round(pct)}%`}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Headings
 * ------------------------------------------------------------------ */

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cx(
        "flex flex-wrap items-end justify-between gap-x-8 gap-y-4",
        className,
      )}
    >
      <div className="max-w-[62ch]">
        <h1 className="t-title text-[clamp(1.9rem,3.6vw,2.5rem)] text-ink">
          {title}
        </h1>
        {description ? (
          <p className="t-body mt-3 text-[0.9375rem] text-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-3">{actions}</div>
      ) : null}
    </header>
  );
}

export function SectionHeading({
  children,
  aside,
  className,
}: {
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-wrap items-baseline justify-between gap-2",
        className,
      )}
    >
      <h2 className="t-title text-[1.0625rem] tracking-[-0.01em] text-ink">
        {children}
      </h2>
      {aside}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Empty state — designed, never a shrug.
 * ------------------------------------------------------------------ */

export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "panel-quiet mx-auto flex w-full max-w-[46rem] flex-col items-center px-6 py-14 text-center",
        className,
      )}
    >
      <CrosshairMark />
      <p className="mt-5 text-[0.9375rem] font-medium text-ink">{title}</p>
      {children ? (
        <p className="t-body mt-2 max-w-[46ch] text-sm text-muted">
          {children}
        </p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

/** Authored mark: an aperture with halftone falloff. Not a unicode glyph. */
export function CrosshairMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={cx("size-10 text-faint", className)}
      fill="none"
      aria-hidden="true"
    >
      <circle cx="20" cy="20" r="12.5" stroke="currentColor" strokeWidth="1" />
      <circle cx="20" cy="20" r="3" fill="currentColor" opacity="0.55" />
      <path
        d="M20 1.5v7M20 31.5v7M1.5 20h7M31.5 20h7"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
      <circle
        cx="20"
        cy="20"
        r="19"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="0.5 3.5"
        opacity="0.5"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * RoundHash — a round's public identifier, set as an instrument reading.
 * ------------------------------------------------------------------ */

/**
 * The round's id, shortened for display.
 *
 * A round has no human name that stays unique — its title repeats, its slug is
 * an operator handle. The UUID is the one string that names this round and no
 * other, so surfaces show it wherever a round instance needs a stable handle.
 * Shortened to its first two UUID groups: enough to recognise and quote, short
 * enough to sit in a row beside a status. The full id stays in the title and on
 * the detail page's own record.
 *
 * Set in tabular mono, never in prose: it is a reading, not a word.
 */
export function RoundHash({
  id,
  className,
  full = false,
}: {
  id: string;
  className?: string;
  /** Show the whole id instead of the short form. */
  full?: boolean;
}) {
  return (
    <span
      className={cx("t-num text-[0.625rem] text-faint", className)}
      title={id}
    >
      {full ? id : shortRoundId(id)}
    </span>
  );
}

/** `3f9a1c2e-7b40` — first two UUID groups, or the id as given if it is not one. */
export function shortRoundId(id: string): string {
  const groups = id.split("-");
  if (groups.length < 2) return id.slice(0, 13);
  return `${groups[0]}-${groups[1]}`;
}

/* ------------------------------------------------------------------ *
 * Readout — a labelled number, the instrument-panel atom.
 * ------------------------------------------------------------------ */

export function Readout({
  label,
  value,
  suffix,
  className,
}: {
  label: string;
  value: ReactNode;
  suffix?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="t-label text-[0.625rem] text-faint">{label}</p>
      <p className="t-num mt-1.5 text-[1.375rem] text-ink">
        {value}
        {suffix ? (
          <span className="ml-1 text-xs text-muted">{suffix}</span>
        ) : null}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * RoundBento — a round's pre-lock statistics as an instrument grid.
 * ------------------------------------------------------------------ */

/**
 * One stat tile: an instrument label, a readout, a quiet note. The label is
 * the React key, so it must be unique within one grid.
 */
export interface BentoStat {
  label: string;
  value: ReactNode;
  /** A small mono unit riding after the value ("SOL", "%", "tokens"). */
  suffix?: string;
  /** A quiet mono line pinned to the tile's bottom edge. */
  note?: string;
}

/**
 * The bento: a round's statistics, shown while the round is still open.
 *
 * A stack of equal full-width slabs made every statistic look equally
 * important and none of them findable — a viewer had to read paragraphs to
 * find one number. The grid gives each statistic a fixed instrument cell so a
 * viewer scans a row instead. Tiles use the nested-data material (12px radius,
 * hairline, 1.5% fill), deliberately lighter than a panel: the market board is
 * the exhibit, these are the readings around it.
 *
 * The caller decides when the grid exists — the product's rule is that these
 * statistics appear before the round closes and vanish the moment it locks.
 * The grid is a definition list because every tile is a term and its reading.
 */
export function RoundBento({
  stats,
  className,
}: {
  stats: BentoStat[];
  className?: string;
}) {
  return (
    <dl
      className={cx(
        "grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4",
        className,
      )}
    >
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="flex min-w-0 flex-col rounded-xl border border-hairline bg-white/[0.015] px-4 py-3.5"
        >
          <dt className="t-label text-[0.5625rem] text-faint">{stat.label}</dt>
          <dd className="t-num mt-2 text-[1.375rem] leading-none break-words text-ink">
            {stat.value}
            {stat.suffix ? (
              <span className="ml-1 text-[0.6875rem] text-muted">
                {stat.suffix}
              </span>
            ) : null}
          </dd>
          {stat.note ? (
            <dd className="t-mono mt-auto pt-3.5 text-[0.5625rem] leading-relaxed text-faint">
              {stat.note}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
