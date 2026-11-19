import "server-only";

import type { ResultDisplayState } from "@ai-showdown/shared";

/**
 * How a round's stored outcome reads to a viewer (F19) — the pure part.
 *
 * This module deliberately re-derives nothing. The F15 resolver already decided
 * the round (`round_outcomes`) and F18 already settled it; the results view's
 * only job is to pick the right words for the state that was recorded. Keeping
 * the choice pure and tested is what stops the page from silently showing a
 * winner for a void, or an unexplained verdict for a round whose judge was
 * simply unreachable.
 *
 * No amber: per the design system, amber is reserved for account warnings and
 * must never encode a round state.
 */

/** The subset of a round's outcome this decision needs. */
export interface DisplayStateInput {
  /** The round's lifecycle status. */
  status: string;
  outcome: {
    kind: "settled" | "voided";
    winnerModelId: string | null;
    tieBreak: string | null;
    allForfeited: boolean;
  } | null;
  /** The per-model conformance statuses recorded for the round. */
  modelStatuses: readonly string[];
}

/** Round statuses that carry a final, displayable outcome. */
const DECIDED_STATUSES: readonly string[] = ["SETTLED", "VOIDED", "ARCHIVED"];

/**
 * The state to render.
 *
 * Order matters. A round that has not been decided is `pending` regardless of
 * whatever partial verdicts exist — showing a "winner" for a running round is
 * the mistake the two-clocks rule exists to prevent. Once decided, the recorded
 * outcome is authoritative:
 *
 *   * all models forfeited → `all-forfeited` (nothing ran well enough to judge);
 *   * voided otherwise     → `no-conformer` (it rendered, no model followed the brief);
 *   * a settled tie broken by vote/order → `tie`;
 *   * a settled winner     → `winner`.
 *
 * `judge-unavailable` is only surfaced for an undecided round where a model's
 * ruling is `unavailable` — i.e. the honest "we could not judge this yet". A
 * decided round outranks it: settlement would not have happened on a guess.
 */
export function resolveDisplayState(input: DisplayStateInput): ResultDisplayState {
  const decided = DECIDED_STATUSES.includes(input.status);

  if (!decided) {
    // An undecided round whose judge could not see a model's frames is being
    // retried, not ignored — say so instead of the flat "pending".
    if (input.modelStatuses.includes("unavailable")) return "judge-unavailable";
    return "pending";
  }

  const outcome = input.outcome;
  if (!outcome) {
    // Decided in the lifecycle but with no outcome row: a cancelled/failed
    // round, or a data gap. It reads as a void with no winner, never a win.
    return "voided";
  }

  if (outcome.kind === "voided") {
    return outcome.allForfeited ? "all-forfeited" : "no-conformer";
  }

  if (outcome.tieBreak === "crowd-vote" || outcome.tieBreak === "stable-order") {
    return "tie";
  }

  return "winner";
}

/** Dot tone + word for a model's conformance status (never amber). */
export interface StatusWord {
  tone: "live" | "violet" | "ink" | "idle";
  label: string;
}

export function modelStatusWord(status: string): StatusWord {
  switch (status) {
    case "conformed":
      return { tone: "ink", label: "Conformed" };
    case "not_conformed":
      return { tone: "idle", label: "Off brief" };
    case "forfeited":
      return { tone: "idle", label: "Forfeited" };
    case "unavailable":
      return { tone: "violet", label: "Judge unavailable" };
    default:
      return { tone: "idle", label: "Pending" };
  }
}

/** Plain-language headline for the overall outcome, safe to show a viewer. */
export function displayStateHeadline(state: ResultDisplayState): string {
  switch (state) {
    case "winner":
      return "A model conformed to the brief";
    case "tie":
      return "More than one model conformed";
    case "all-forfeited":
      return "Every model forfeited";
    case "no-conformer":
      return "No model conformed";
    case "judge-unavailable":
      return "The judge could not rule yet";
    case "voided":
      return "This round was void";
    case "pending":
      return "This round is not settled yet";
  }
}
