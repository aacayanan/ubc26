/**
 * Deadline countdown (F9) — pure, no I/O, no React.
 *
 * Deliberately client-safe (no `server-only`): the round list ticks in the
 * browser. Keeping the arithmetic here rather than inside the component is what
 * makes "a refresh shows the right time" and "the deadline passing is handled"
 * testable without a DOM.
 *
 * Two properties the product depends on:
 *
 *   * **The deadline is absolute.** Everything is computed from the round's
 *     `prediction_deadline` and the current wall clock — never from a
 *     mount-relative offset — so a page refresh, a background tab throttling its
 *     timer, or a slow first paint all land on the same number.
 *   * **Expiry is reported, not inferred.** `expired` is computed from the
 *     clock, so the urgent styling and the "no longer actionable" switch cannot
 *     drift out of step with the digits on screen.
 */

export interface Countdown {
  /** Whole milliseconds remaining, clamped at 0. */
  remainingMs: number;
  /** True at and after the deadline. */
  expired: boolean;
  /** True when the deadline is missing or unparseable (an unavailable round). */
  invalid: boolean;
}

/** Below this, the countdown is shown in the urgent register. */
export const URGENT_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Remaining time until `deadline`, evaluated at `now`.
 *
 * An unparseable deadline is reported as both `invalid` and `expired`: a round
 * whose clock we cannot read must never look safe to stake on.
 */
export function getCountdown(
  deadline: string | Date | null | undefined,
  now: Date = new Date(),
): Countdown {
  if (deadline === null || deadline === undefined) {
    return { remainingMs: 0, expired: true, invalid: true };
  }

  const target = deadline instanceof Date ? deadline : new Date(deadline);
  const targetMs = target.getTime();

  if (Number.isNaN(targetMs)) {
    return { remainingMs: 0, expired: true, invalid: true };
  }

  const remainingMs = targetMs - now.getTime();

  return {
    remainingMs: Math.max(0, remainingMs),
    expired: remainingMs <= 0,
    invalid: false,
  };
}

/**
 * Render remaining milliseconds as a compact readout.
 *
 * Seconds round **up**, so a deadline is only ever shown as `0:00` once it has
 * actually passed — a countdown that reads zero with time still on the clock is
 * the one failure mode that would let someone believe staking is closed early.
 *
 *   >= 1 day   `2d 04:31:07`
 *   >= 1 hour  `04:31:07`
 *   < 1 hour   `4:07`
 */
export function formatCountdown(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.ceil(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

/**
 * The whole readout for a round card: the digits plus the register they belong
 * in. One call so the digits and the styling can never disagree.
 */
export function describeDeadline(
  deadline: string | Date | null | undefined,
  now: Date = new Date(),
): Countdown & { text: string; urgent: boolean } {
  const countdown = getCountdown(deadline, now);

  if (countdown.invalid) {
    return { ...countdown, text: "Deadline unavailable", urgent: false };
  }

  return {
    ...countdown,
    text: countdown.expired ? "Locked" : formatCountdown(countdown.remainingMs),
    urgent: !countdown.expired && countdown.remainingMs <= URGENT_THRESHOLD_MS,
  };
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
