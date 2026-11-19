import { describe, expect, it } from "vitest";
import {
  FAN_FAVORITE_AWARD_POINTS,
  computeFanFavoriteAwards,
  computeParimutuelPayouts,
  type PoolStake,
} from "@/lib/server/services/scoring/parimutuel";

/**
 * F18 pool math.
 *
 * The database side (one score event per user per kind, pot conservation inside
 * `settle_round`, the settle-before-finalize ordering) is covered by
 * `supabase/tests/f18_settlement.sql`. These pin the arithmetic and the
 * determinism, which is where a rounding rule quietly goes wrong.
 */

function stake(
  predictionId: string,
  modelId: string,
  points: number,
  userId = `user-${predictionId}`,
): PoolStake {
  return { predictionId, userId, modelId, points };
}

describe("computeParimutuelPayouts", () => {
  it("splits the pot pro-rata among backers of the winner", () => {
    const result = computeParimutuelPayouts({
      stakes: [
        stake("p1", "winner", 100),
        stake("p2", "winner", 100),
        stake("p3", "loser", 200),
      ],
      winnerModelId: "winner",
      kind: "settled",
    });

    expect(result.pot).toBe(400);
    expect(result.winningStake).toBe(200);

    const byId = Object.fromEntries(
      result.settlements.map((s) => [s.predictionId, s]),
    );

    // Pot 400 split across 200 of winning stake => 2x each backer.
    expect(byId.p1).toMatchObject({ outcome: "won", pointsAwarded: 200 });
    expect(byId.p2).toMatchObject({ outcome: "won", pointsAwarded: 200 });
    expect(byId.p3).toMatchObject({ outcome: "lost", pointsAwarded: 0 });
  });

  it("conserves the pot exactly when shares do not divide evenly", () => {
    // Pot 100 across winning stake 3: each backer's exact share is 33.33….
    const result = computeParimutuelPayouts({
      stakes: [
        stake("a", "winner", 1),
        stake("b", "winner", 1),
        stake("c", "winner", 1),
        stake("d", "loser", 97),
      ],
      winnerModelId: "winner",
      kind: "settled",
    });

    expect(result.pot).toBe(100);

    const credited = result.settlements.reduce(
      (sum, s) => sum + s.pointsAwarded,
      0,
    );
    expect(credited).toBe(result.pot);

    // 100/3 = 33.33 each: floors to 33, one leftover point to exactly one backer.
    const won = result.settlements.filter((s) => s.outcome === "won");
    expect(won).toHaveLength(3);
    expect(won.map((s) => s.pointsAwarded).sort()).toEqual([33, 33, 34]);
  });

  it("breaks remainder ties deterministically by prediction id", () => {
    const stakes = [
      stake("b", "winner", 1),
      stake("a", "winner", 1),
      stake("c", "loser", 1),
    ];

    // Same inputs in two different orders must produce the same awards, so a
    // retried settlement cannot drift.
    const forward = computeParimutuelPayouts({
      stakes,
      winnerModelId: "winner",
      kind: "settled",
    });
    const reversed = computeParimutuelPayouts({
      stakes: [...stakes].reverse(),
      winnerModelId: "winner",
      kind: "settled",
    });

    const pick = (p: typeof forward) =>
      Object.fromEntries(
        p.settlements.map((s) => [s.predictionId, s.pointsAwarded]),
      );

    expect(pick(forward)).toEqual(pick(reversed));
    // Tie broken toward the smallest id.
    expect(pick(forward).a).toBe(2);
    expect(pick(forward).b).toBe(1);
    expect(creditedOf(forward)).toBe(forward.pot);
  });

  it("respects proportional weighting across unequal stakes", () => {
    const result = computeParimutuelPayouts({
      stakes: [
        stake("big", "winner", 300),
        stake("small", "winner", 100),
        stake("other", "loser", 100),
      ],
      winnerModelId: "winner",
      kind: "settled",
    });

    const byId = Object.fromEntries(
      result.settlements.map((s) => [s.predictionId, s]),
    );
    // Pot 500, winning stake 400: big 300/400*500 = 375, small 125.
    expect(byId.big.pointsAwarded).toBe(375);
    expect(byId.small.pointsAwarded).toBe(125);
    expect(creditedOf(result)).toBe(500);
  });

  it("returns every stake as void on a voided round", () => {
    const result = computeParimutuelPayouts({
      stakes: [stake("p1", "a", 100), stake("p2", "b", 50)],
      winnerModelId: null,
      kind: "voided",
    });

    expect(result.pot).toBe(150);
    expect(result.settlements.every((s) => s.outcome === "void")).toBe(true);
    expect(result.settlements.every((s) => s.pointsAwarded === 0)).toBe(true);
    expect(creditedOf(result)).toBe(0);
  });

  it("returns stakes when the winner had no backers", () => {
    const result = computeParimutuelPayouts({
      stakes: [stake("p1", "loser", 100)],
      winnerModelId: "winner",
      kind: "settled",
    });

    expect(result.winningStake).toBe(0);
    expect(result.unbacked).toBe(true);
    expect(result.settlements.every((s) => s.outcome === "void")).toBe(true);
    expect(creditedOf(result)).toBe(0);
  });

  it("handles a round with no stakes", () => {
    const result = computeParimutuelPayouts({
      stakes: [],
      winnerModelId: "winner",
      kind: "settled",
    });

    expect(result.pot).toBe(0);
    expect(result.winningStake).toBe(0);
    expect(result.settlements).toEqual([]);
  });

  it("rejects a settled round without a winner and a void with one", () => {
    expect(() =>
      computeParimutuelPayouts({
        stakes: [],
        winnerModelId: null,
        kind: "settled",
      }),
    ).toThrow(/settled round must name/);

    expect(() =>
      computeParimutuelPayouts({
        stakes: [],
        winnerModelId: "m",
        kind: "voided",
      }),
    ).toThrow(/voided round has no winner/);
  });

  it("rejects a non-integer stake", () => {
    expect(() =>
      computeParimutuelPayouts({
        stakes: [stake("p1", "winner", 10.5)],
        winnerModelId: "winner",
        kind: "settled",
      }),
    ).toThrow(/non-integer/);
  });
});

describe("computeFanFavoriteAwards", () => {
  it("pays each voter of the fan-favorite model the fixed award", () => {
    const awards = computeFanFavoriteAwards({
      votes: [
        { userId: "u1", modelId: "fav" },
        { userId: "u2", modelId: "fav" },
        { userId: "u3", modelId: "other" },
      ],
      fanFavoriteModelId: "fav",
    });

    expect(awards).toEqual([
      { userId: "u1", points: FAN_FAVORITE_AWARD_POINTS },
      { userId: "u2", points: FAN_FAVORITE_AWARD_POINTS },
    ]);
  });

  it("pays nobody when there is no fan favorite", () => {
    expect(
      computeFanFavoriteAwards({
        votes: [{ userId: "u1", modelId: "fav" }],
        fanFavoriteModelId: null,
      }),
    ).toEqual([]);
  });

  it("never pays the same account twice", () => {
    const awards = computeFanFavoriteAwards({
      votes: [
        { userId: "u1", modelId: "fav" },
        { userId: "u1", modelId: "fav" },
      ],
      fanFavoriteModelId: "fav",
    });

    expect(awards).toHaveLength(1);
  });

  it("honours a custom award size and rejects a non-positive one", () => {
    expect(
      computeFanFavoriteAwards({
        votes: [{ userId: "u1", modelId: "fav" }],
        fanFavoriteModelId: "fav",
        awardPoints: 5,
      }),
    ).toEqual([{ userId: "u1", points: 5 }]);

    expect(() =>
      computeFanFavoriteAwards({
        votes: [{ userId: "u1", modelId: "fav" }],
        fanFavoriteModelId: "fav",
        awardPoints: 0,
      }),
    ).toThrow(/positive integer/);
  });
});

function creditedOf(result: {
  settlements: Array<{ pointsAwarded: number }>;
}): number {
  return result.settlements.reduce((sum, s) => sum + s.pointsAwarded, 0);
}
