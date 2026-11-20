import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoundStatus } from "@ai-showdown/shared";
import { InternalError } from "@/lib/server/errors/app-error";

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * A user's prediction history (F26).
 *
 * Predictions are accepted Devnet SOL wagers (`public.wagers`); the points
 * pool is retired. RLS scopes reads to the owner, but the page is a client
 * component, so this reads with the service role for an explicit user id.
 *
 * An open wager shows its amount with no outcome; a settled one shows
 * `settlement_outcome` (`refunded` reads as void) and its payout.
 *
 * Two separate axes, and the page needs both:
 *
 *   - **`state`** — where the stake is in its life: waiting on the betting clock,
 *     waiting on the round, waiting on settlement, or final. This is what a
 *     reader is actually asking ("did this happen yet?").
 *   - **`outcome`** — what the settled stake paid. Only meaningful once `state`
 *     is `won`/`lost`/`void`; null while any clock is still running.
 *
 * A round can also be voided *before* settlement flips the stakes (F15 all-
 * forfeit ⇒ `VOIDED`). That case reports `state = "void"` with a null outcome
 * rather than claiming a payout that may not have been written yet.
 */

/** One stake's place in the lifecycle. `won`/`lost`/`void` are terminal. */
export type StakeState =
  "open" | "locked" | "running" | "settling" | "won" | "lost" | "void";

export interface StakeRecord {
  id: string;
  roundId: string;
  briefTitle: string;
  pickedModel: string;
  /** Devnet SOL wagered. */
  amountSol: number;
  /** Devnet SOL returned; null until settlement writes an outcome. */
  payoutSol: number | null;
  /** Settlement ruling; null until the round settles. */
  outcome: "won" | "lost" | "void" | null;
  state: StakeState;
  /** Raw lifecycle status, for copy that wants to name the round's phase. */
  roundStatus: string;
  /**
   * Where to read the full explanation of this round's result. Null until the
   * round is past `OPEN` — a result page for an open round would show nothing.
   */
  resultHref: string | null;
  createdAt: string;
}

/** Round statuses whose result page is public (any point past `OPEN`). */
const RESULT_VISIBLE: readonly RoundStatus[] = [
  "LOCKED",
  "RUNNING",
  "EVALUATING",
  "SETTLED",
  "VOIDED",
  "ARCHIVED",
  "RETRYING",
  "FAILED",
  "CANCELLED",
];

function deriveState(
  roundStatus: string,
  outcome: StakeRecord["outcome"],
): StakeState {
  if (outcome === "won" || outcome === "lost" || outcome === "void") {
    return outcome;
  }
  switch (roundStatus) {
    case "OPEN":
      return "open";
    case "LOCKED":
      return "locked";
    case "RUNNING":
    case "EVALUATING":
    case "RETRYING":
      return "running";
    case "VOIDED":
    // Voided before settlement: no payout was written, but the stake is over.
    case "FAILED":
    case "CANCELLED":
      // A round that cannot settle never pays a stake out; show it as over
      // rather than leaving it eternally "running".
      return "void";
    case "SETTLED":
    case "ARCHIVED":
      // Settled but no per-stake outcome: treat as awaiting the payout record
      // rather than inventing a win or a loss.
      return "settling";
    default:
      return "locked";
  }
}

export async function listUserStakes(
  userId: string,
  supabase: SupabaseClient,
): Promise<StakeRecord[]> {
  // `wagers` has no direct FK to `llm_models` — its only model reference is
  // the composite FK to `round_models(round_id, model_id)`. PostgREST embeds
  // follow declared FKs, so `llm_models(name)` off `predictions` is not a
  // relationship and the whole query 400s. The pick's name comes back through
  // `rounds → round_models → llm_models` instead, which is the path every other
  // query in this codebase takes.
  const { data, error } = await supabase
    .from("wagers")
    .select(
      "id, round_id, model_id, lamports, payout_lamports, settlement_outcome, created_at, rounds(status, challenges(title), round_models(model_id, llm_models(name)))",
    )
    .eq("user_id", userId)
    .eq("status", "accepted")
    .order("created_at", { ascending: false });

  if (error) {
    throw new InternalError("Failed to read your stakes", error);
  }

  return (
    (data ?? []) as Array<{
      id: string;
      round_id: string;
      model_id: string;
      lamports: number | string | null;
      payout_lamports: number | string | null;
      settlement_outcome: string | null;
      created_at: string;
      rounds:
        | {
            status: string;
            challenges: { title: string } | Array<{ title: string }> | null;
            round_models: Array<{
              model_id: string;
              llm_models: { name: string } | Array<{ name: string }> | null;
            }> | null;
          }
        | Array<{
            status: string;
            challenges: { title: string } | Array<{ title: string }> | null;
            round_models: Array<{
              model_id: string;
              llm_models: { name: string } | Array<{ name: string }> | null;
            }> | null;
          }>
        | null;
    }>
  ).map((row) => {
    const round = Array.isArray(row.rounds) ? row.rounds[0] : row.rounds;
    const challenge = Array.isArray(round?.challenges)
      ? round.challenges[0]
      : round?.challenges;

    // Pick this round's roster entry matching the stake's model, then read the
    // name off it. Matching on model_id keeps the name tied to the actual pick.
    const rosterEntry = (round?.round_models ?? []).find(
      (entry) => entry.model_id === row.model_id,
    );
    const model = Array.isArray(rosterEntry?.llm_models)
      ? rosterEntry.llm_models[0]
      : rosterEntry?.llm_models;

    const outcome =
      row.settlement_outcome === "won" || row.settlement_outcome === "lost"
        ? row.settlement_outcome
        : row.settlement_outcome === "refunded"
          ? "void"
          : null;

    const roundStatus = round?.status ?? "";

    return {
      id: row.id,
      roundId: row.round_id,
      briefTitle: challenge?.title ?? "Round",
      pickedModel: model?.name ?? "Model",
      amountSol: Number(row.lamports ?? 0) / LAMPORTS_PER_SOL,
      payoutSol:
        outcome === null
          ? null
          : Number(row.payout_lamports ?? 0) / LAMPORTS_PER_SOL,
      outcome,
      state: deriveState(roundStatus, outcome),
      roundStatus,
      resultHref: RESULT_VISIBLE.includes(roundStatus as RoundStatus)
        ? `/results/${row.round_id}`
        : null,
      createdAt: row.created_at,
    };
  });
}
