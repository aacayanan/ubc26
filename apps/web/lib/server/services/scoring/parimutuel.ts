import "server-only";

/**
 * Parimutuel points pool (F18) — the pure math, no I/O.
 *
 * A round's pot is the sum of every conformance stake placed before the
 * deadline. Backers of the conforming winner split it in proportion to their
 * stake; everyone else's stake simply returns nothing, because points are never
 * debited at stake time (see `20261119000800_f18_stakes_and_votes.sql`). The
 * only thing settlement ever does to a balance is credit it.
 *
 * Three properties this module has to keep, each with a test:
 *
 *   * **The pot is conserved.** The credited total equals the pot exactly —
 *     fractional shares are floored and the remainder is handed out one point at
 *     a time, largest fractional remainder first, so no point is minted or lost.
 *   * **The result is deterministic.** Remainder ties are broken by prediction
 *     id, never by array order, so re-settling a round gives the same numbers.
 *   * **Nobody backed means nobody wins.** If the winner had no backers, no one
 *     is paid; the stakes return (which, in a non-escrow ledger, means recording
 *     them as void rather than crediting anything).
 */

/** The smallest stake the product accepts. Mirrors the stake form's hint. */
export const MIN_STAKE_POINTS = 10;

/**
 * The fan-favorite award, per account that voted for the crowd's winner.
 *
 * Deliberately smaller than a typical pot share: the crowd vote is free to cast,
 * so it rewards reading the room without competing with the pool. It is an
 * award, not a refund — a voter's stake is unaffected by it.
 */
export const FAN_FAVORITE_AWARD_POINTS = 25;

/** One row of the pool as settlement sees it. */
export interface PoolStake {
  predictionId: string;
  userId: string;
  modelId: string;
  points: number;
}

/** How one backer's stake resolved. Mirrors `predictions.settlement_outcome`. */
export type StakeOutcome = "won" | "lost" | "void";

export interface StakeSettlement {
  predictionId: string;
  userId: string;
  outcome: StakeOutcome;
  /** Points credited by this stake. 0 on a loss and on a void. */
  pointsAwarded: number;
}

export interface ParimutuelPayouts {
  /** Every conformance stake in the round, settled. */
  settlements: StakeSettlement[];
  /** Sum of all stakes: what the winner's backers split. */
  pot: number;
  /** Sum of the stakes placed on the winning model. */
  winningStake: number;
  /**
   * True when the round settled but the winner had no backers, so the pot had
   * nowhere to go. Every stake is recorded `void`.
   */
  unbacked: boolean;
}

export type RoundKind = "settled" | "voided";

/**
 * Split the pot among backers of the winning model.
 *
 * `kind = "voided"` returns every stake as void with zero points — the round
 * produced no winner to back. `winnerModelId === null` is only legal for a void.
 */
export function computeParimutuelPayouts(input: {
  stakes: readonly PoolStake[];
  winnerModelId: string | null;
  kind: RoundKind;
}): ParimutuelPayouts {
  const { stakes, winnerModelId, kind } = input;

  if (kind === "settled" && !winnerModelId) {
    throw new Error(
      "A settled round must name the model whose backers split the pot",
    );
  }
  if (kind === "voided" && winnerModelId) {
    throw new Error("A voided round has no winner to pay");
  }

  for (const stake of stakes) {
    if (!Number.isInteger(stake.points) || stake.points < 0) {
      throw new Error(
        `Stake ${stake.predictionId} has a non-integer point amount`,
      );
    }
  }

  const pot = stakes.reduce((sum, stake) => sum + stake.points, 0);
  const backers = winnerModelId
    ? stakes.filter((stake) => stake.modelId === winnerModelId)
    : [];
  const winningStake = backers.reduce((sum, stake) => sum + stake.points, 0);

  // A void, or a winner nobody backed: nothing can be paid out. Recording the
  // stake as void is what "returned" means in a ledger that never debited it.
  if (kind === "voided" || winningStake === 0) {
    return {
      settlements: stakes.map((stake) => ({
        ...toRow(stake),
        outcome: "void",
        pointsAwarded: 0,
      })),
      pot,
      winningStake,
      unbacked: kind === "settled",
    };
  }

  const shares = splitPot(backers, pot, winningStake);
  const byId = new Map(
    shares.map((share) => [share.predictionId, share.awarded]),
  );

  const settlements: StakeSettlement[] = stakes.map((stake) => {
    const awarded = byId.get(stake.predictionId);
    if (awarded === undefined) {
      return { ...toRow(stake), outcome: "lost", pointsAwarded: 0 };
    }
    return { ...toRow(stake), outcome: "won", pointsAwarded: awarded };
  });

  return { settlements, pot, winningStake, unbacked: false };
}

/**
 * Largest-remainder split, so the awards add up to the pot exactly.
 *
 * Each backer's exact share is `stake / winningStake * pot`. Flooring every
 * share leaves fewer than `backers.length` points unassigned; they go to the
 * backers with the largest fractional part, and equal fractions are broken by
 * prediction id so the split does not depend on input order.
 */
function splitPot(
  backers: readonly PoolStake[],
  pot: number,
  winningStake: number,
): Array<{ predictionId: string; awarded: number }> {
  const parts = backers.map((stake) => {
    const exact = (stake.points * pot) / winningStake;
    const floored = Math.floor(exact);
    return {
      predictionId: stake.predictionId,
      awarded: floored,
      // Compare remainders as integers to sidestep floating-point drift:
      // exact - floored is the fractional part scaled by winningStake.
      remainder: stake.points * pot - floored * winningStake,
    };
  });

  let unassigned = pot - parts.reduce((sum, part) => sum + part.awarded, 0);

  const ordered = [...parts].sort((a, b) =>
    b.remainder !== a.remainder
      ? b.remainder - a.remainder
      : a.predictionId < b.predictionId
        ? -1
        : a.predictionId > b.predictionId
          ? 1
          : 0,
  );

  for (let index = 0; unassigned > 0; index += 1, unassigned -= 1) {
    ordered[index % ordered.length].awarded += 1;
  }

  return parts;
}

/** The fan-favorite award: one per account that voted for the crowd's winner. */
export interface FanFavoriteAward {
  userId: string;
  points: number;
}

export function computeFanFavoriteAwards(input: {
  votes: ReadonlyArray<{ userId: string; modelId: string }>;
  fanFavoriteModelId: string | null;
  awardPoints?: number;
}): FanFavoriteAward[] {
  const { votes, fanFavoriteModelId } = input;
  const awardPoints = input.awardPoints ?? FAN_FAVORITE_AWARD_POINTS;

  // No crowd winner (nobody voted, or the round is void): nobody is rewarded.
  if (!fanFavoriteModelId) return [];

  if (!Number.isInteger(awardPoints) || awardPoints <= 0) {
    throw new Error("The fan-favorite award must be a positive integer");
  }

  // One vote per (round, user) is a database constraint, but de-duplicating
  // here keeps a malformed tally from paying an account twice.
  const paid = new Set<string>();
  const awards: FanFavoriteAward[] = [];

  for (const vote of votes) {
    if (vote.modelId !== fanFavoriteModelId) continue;
    if (paid.has(vote.userId)) continue;
    paid.add(vote.userId);
    awards.push({ userId: vote.userId, points: awardPoints });
  }

  return awards;
}

function toRow(
  stake: PoolStake,
): Omit<StakeSettlement, "outcome" | "pointsAwarded"> {
  return {
    predictionId: stake.predictionId,
    userId: stake.userId,
  };
}
