import "server-only";

import { ValidationError } from "@/lib/server/errors/app-error";

/**
 * Failure, tie and void policy for a round (F15).
 *
 * F14 answers "did this model's render pass the deterministic gate?" and F31
 * answers "does the judge think it follows the brief?". Neither decides what a
 * round's outcome is. That is this module: it turns per-model verdicts (plus the
 * crowd vote, F32) into exactly one resolution — settled with a winner, voided,
 * retryable, or not yet decidable.
 *
 * Three rules it exists to keep:
 *
 *   * **A failed gate is a forfeit.** The gate is the qualification rule, so a
 *     render error, a timeout, a missing frame, a wrong size or a blank canvas
 *     all mean the model forfeits. It is never sent to the judge and never
 *     eligible for fan-favorite points (REQUIREMENTS.md non-negotiable #9).
 *   * **Infrastructure is not a verdict.** If a model's frames never reached
 *     the judge, or the sandbox itself was down, the round must not settle on a
 *     guess. It is retryable instead.
 *   * **A tie never resolves by chance.** Equal conformance is broken by the
 *     crowd's fan-favorite vote; if the vote itself ties, a fixed round order
 *     decides, and the reason says so. Same inputs always give the same winner.
 *
 * Kept pure and free of I/O so every rule is unit-testable and a stored round
 * can be re-resolved from its persisted inputs.
 */

/**
 * What happened to one model in a round.
 *
 * The four persisted values mirror the `public.result_status` values F15 adds.
 * `pending` exists only here: it means "the pipeline has not produced a verdict
 * yet" and is never written to `competition_results`, because a pending model
 * makes the whole round undecidable rather than producing a row.
 */
export type ModelConformance =
  "conformed" | "not_conformed" | "forfeited" | "unavailable" | "pending";

/** The subset that can be persisted as a `competition_results` row. */
export type PersistedConformance = Exclude<ModelConformance, "pending">;

/** The F31 judge's ruling on one model's captured frames. */
export type JudgeVerdict =
  | { kind: "ruled"; conformed: boolean; reason: string }
  | { kind: "unavailable"; reason: string };

/** What F14 recorded about the render. Structural, so `EvaluateArtifactResult` fits. */
export interface GateVerdict {
  passed: boolean;
  /** Infrastructure failure — the sandbox never ran. Never the model's fault. */
  unavailable: boolean;
  failureReason: string | null;
}

export interface ClassifiedOutcome {
  conformance: ModelConformance;
  /** Plain-language explanation, safe to show a viewer (F19). */
  reason: string;
}

/**
 * Combine the deterministic gate with the judge's ruling into one verdict.
 *
 * Order is load-bearing:
 *   1. the gate decides qualification first — an unjudged failed render can
 *      never be rescued by a later judge call;
 *   2. no judge verdict yet means `pending`, not a guess;
 *   3. a judge outage is `unavailable` (retryable), not a conformance ruling;
 *   4. only then does the judge's answer mean anything.
 */
export function classifyModelOutcome(input: {
  gate: GateVerdict;
  judge: JudgeVerdict | null;
}): ClassifiedOutcome {
  const { gate, judge } = input;

  if (gate.unavailable) {
    return {
      conformance: "unavailable",
      reason:
        gate.failureReason ??
        "The render sandbox was unavailable, so this model could not be evaluated.",
    };
  }

  if (!gate.passed) {
    return {
      conformance: "forfeited",
      reason:
        gate.failureReason ??
        "The render did not pass the deterministic checks, so it forfeits.",
    };
  }

  if (judge === null) {
    return {
      conformance: "pending",
      reason: "The deterministic checks passed; the judge has not ruled yet.",
    };
  }

  if (judge.kind === "unavailable") {
    return {
      conformance: "unavailable",
      reason: `The judge could not see this model's frames: ${judge.reason}`,
    };
  }

  return judge.conformed
    ? {
        conformance: "conformed",
        reason: judge.reason || "The judge ruled the render follows the brief.",
      }
    : {
        conformance: "not_conformed",
        reason:
          judge.reason ||
          "The judge ruled the render does not follow the brief.",
      };
}

export interface ModelOutcomeInput {
  modelId: string;
  /** Display name, used in the plain-language reason. */
  name: string;
  /** Stable round ordering (`round_models.ordinal`). Never re-sorted at random. */
  ordinal: number;
  conformance: ModelConformance;
  reason: string;
}

export interface ModelResultRow {
  modelId: string;
  name: string;
  ordinal: number;
  status: PersistedConformance;
  reason: string;
}

/** Fan-favorite vote counts by `model_id`. Missing means zero. */
export interface CrowdVoteTally {
  counts: Record<string, number>;
}

/**
 * How the winner was decided. Recorded with the outcome so a viewer can see a
 * tie was broken deliberately rather than by accident.
 */
export type TieBreak = "sole-conformer" | "crowd-vote" | "stable-order";

export type RoundResolution =
  | {
      kind: "incomplete";
      reason: string;
      awaitingModelIds: string[];
      results: ModelResultRow[];
    }
  | {
      kind: "retryable";
      reason: string;
      unavailableModelIds: string[];
      results: ModelResultRow[];
    }
  | {
      kind: "settled";
      winnerModelId: string;
      fanFavoriteModelId: string | null;
      tieBreak: TieBreak;
      reason: string;
      results: ModelResultRow[];
    }
  | { kind: "voided"; reason: string; results: ModelResultRow[] };

/**
 * Resolve one round from its per-model verdicts and the crowd vote.
 *
 * Precedence, in order:
 *   * any `pending` model → incomplete (nothing is persisted);
 *   * any `unavailable` model → retryable (the round must not settle on a guess);
 *   * no conforming model → voided (all-forfeit is the common case);
 *   * one conforming model → settled, no tie to break;
 *   * several conforming models → the crowd's fan-favorite vote decides.
 *
 * Fan-favorite points are a separate outcome from conformance (the scoring split
 * in CLAUDE.md): a model the judge ruled `not_conformed` still qualifies for
 * them, because its render passed the deterministic gate.
 */
export function resolveRoundOutcome(
  models: readonly ModelOutcomeInput[],
  votes: CrowdVoteTally = { counts: {} },
): RoundResolution {
  if (models.length === 0) {
    throw new ValidationError("A round needs at least one model to resolve");
  }

  assertUniqueModels(models);
  assertVoteTally(votes);

  // Fixed order everywhere: ordinal, then id. The tiebreak depends on it, so it
  // must not inherit the caller's array order.
  const ordered = [...models].sort(compareModels);

  const pending = ordered.filter((m) => m.conformance === "pending");
  if (pending.length > 0) {
    return {
      kind: "incomplete",
      awaitingModelIds: pending.map((m) => m.modelId),
      reason: `Waiting on ${pending.length} model${pending.length === 1 ? "" : "s"} still to be judged: ${names(pending)}.`,
      // Only decided models have a recordable status; a pending one does not.
      results: ordered
        .filter((m) => m.conformance !== "pending")
        .map(toResultRow),
    };
  }

  const results = ordered.map(toResultRow);

  const unavailable = ordered.filter((m) => m.conformance === "unavailable");
  if (unavailable.length > 0) {
    return {
      kind: "retryable",
      unavailableModelIds: unavailable.map((m) => m.modelId),
      reason: `The round cannot settle yet: ${names(unavailable)} could not be evaluated (${unavailable[0].reason}). It will be retried rather than settled on a guess.`,
      results,
    };
  }

  const conforming = ordered.filter((m) => m.conformance === "conformed");

  if (conforming.length === 0) {
    const everyModelForfeited = ordered.every(
      (m) => m.conformance === "forfeited",
    );
    return {
      kind: "voided",
      reason: everyModelForfeited
        ? "Every model forfeited, so the round is void. No points move and stakes are returned."
        : "No model conformed to the brief, so the round is void. No points move and stakes are returned.",
      results,
    };
  }

  const gatePassing = ordered.filter(
    (m) => m.conformance === "conformed" || m.conformance === "not_conformed",
  );
  const fanFavorite = pickFanFavorite(gatePassing, votes);

  if (conforming.length === 1) {
    const winner = conforming[0];
    return {
      kind: "settled",
      winnerModelId: winner.modelId,
      fanFavoriteModelId: fanFavorite?.modelId ?? null,
      tieBreak: "sole-conformer",
      reason: `${winner.name} was the only model to conform to the brief.`,
      results,
    };
  }

  const winner = pickWinner(conforming, votes);
  return {
    kind: "settled",
    winnerModelId: winner.model.modelId,
    fanFavoriteModelId: fanFavorite?.modelId ?? null,
    tieBreak: winner.tieBreak,
    reason: winner.reason,
    results,
  };
}

/**
 * Whether a model may earn fan-favorite points.
 *
 * One predicate so F17, F18 and F19 cannot each invent their own reading: the
 * crowd may reward any render that passed the deterministic gate, including one
 * the judge found off-brief. A forfeit is never eligible.
 */
export function isEligibleForFanFavorite(
  conformance: ModelConformance,
): boolean {
  return conformance === "conformed" || conformance === "not_conformed";
}

function pickWinner(
  conforming: ModelOutcomeInput[],
  votes: CrowdVoteTally,
): { model: ModelOutcomeInput; tieBreak: TieBreak; reason: string } {
  const counts = conforming.map((m) => votes.counts[m.modelId] ?? 0);
  const top = Math.max(...counts);
  const leaders = conforming.filter(
    (m) => (votes.counts[m.modelId] ?? 0) === top,
  );

  if (leaders.length === 1) {
    const runnerUp = topTwo(counts);
    return {
      model: leaders[0],
      tieBreak: "crowd-vote",
      reason:
        runnerUp === 0
          ? `${conforming.length} models conformed; the crowd voted ${leaders[0].name} best with ${top} vote${top === 1 ? "" : "s"}.`
          : `${conforming.length} models conformed; the crowd voted ${leaders[0].name} best (${top} votes to ${runnerUp}).`,
    };
  }

  // The vote itself tied. Round order decides — deterministic, and stated
  // plainly so the recorded winner is never an unexplained coin flip.
  const chosen = leaders[0];
  return {
    model: chosen,
    tieBreak: "stable-order",
    reason:
      top === 0
        ? `${conforming.length} models conformed and no crowd votes were recorded; round order decides, and ${chosen.name} is recorded as the winner.`
        : `${conforming.length} models conformed and the crowd vote tied at ${top}; round order decides, and ${chosen.name} is recorded as the winner.`,
  };
}

function pickFanFavorite(
  gatePassing: ModelOutcomeInput[],
  votes: CrowdVoteTally,
): ModelOutcomeInput | null {
  if (gatePassing.length === 0) return null;

  let best: ModelOutcomeInput | null = null;
  let bestCount = 0;

  for (const model of gatePassing) {
    const count = votes.counts[model.modelId] ?? 0;
    // Strictly greater, so the first in round order wins a tie.
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }

  return best;
}

function toResultRow(model: ModelOutcomeInput): ModelResultRow {
  if (model.conformance === "pending") {
    // Callers only ever persist a row after the round is decidable, but the
    // type still has to say what this would be. Unreachable in practice.
    throw new ValidationError(
      `Model ${model.modelId} has no resolved outcome to record`,
    );
  }

  return {
    modelId: model.modelId,
    name: model.name,
    ordinal: model.ordinal,
    status: model.conformance,
    reason: model.reason,
  };
}

function compareModels(a: ModelOutcomeInput, b: ModelOutcomeInput): number {
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  return a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0;
}

function names(models: readonly ModelOutcomeInput[]): string {
  const list = models.map((m) => m.name);
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function topTwo(counts: number[]): number {
  const sorted = [...counts].sort((a, b) => b - a);
  return sorted[1] ?? 0;
}

function assertUniqueModels(models: readonly ModelOutcomeInput[]): void {
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.modelId)) {
      throw new ValidationError(
        `Model ${model.modelId} appears more than once in the round`,
      );
    }
    seen.add(model.modelId);
  }
}

function assertVoteTally(votes: CrowdVoteTally): void {
  for (const [modelId, count] of Object.entries(votes.counts)) {
    if (!Number.isInteger(count) || count < 0) {
      throw new ValidationError(
        `Vote count for ${modelId} must be a non-negative integer`,
        { modelId, count },
      );
    }
  }
}
