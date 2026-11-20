import { describe, expect, it } from "vitest";

import { computeDraftPricing, computePoolOdds, formatMultiplier } from "./odds";

/**
 * F9: "live pool odds".
 *
 * Odds are the honest reading of a parimutuel pool: stake one point on a model
 * and, if it wins, `pot / stakedOn(model)` points come back. These tests pin the
 * cases that would otherwise render a misleading number — an unbacked model (no
 * denominator), an empty pot, and a stake on a model that is no longer listed
 * (which still sits in the pot and must be counted or every multiplier inflates).
 */

const MODELS = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
  { id: "c", name: "Gamma" },
];

describe("computePoolOdds", () => {
  it("sums the pot across every model", () => {
    const odds = computePoolOdds({
      models: MODELS,
      stakesByModel: { a: 100, b: 250, c: 150 },
    });
    expect(odds.pot).toBe(500);
  });

  it("computes the multiplier as pot over the model's stake", () => {
    // pot 500: a 100 -> 5x, b 250 -> 2x, c 150 -> 3.33x
    const odds = computePoolOdds({
      models: MODELS,
      stakesByModel: { a: 100, b: 250, c: 150 },
    });

    expect(odds.models.map((model) => model.multiplier)).toEqual([5, 2, 3.33]);
  });

  it("reports share of the pot per model", () => {
    const odds = computePoolOdds({
      models: MODELS,
      stakesByModel: { a: 100, b: 250, c: 150 },
    });
    expect(odds.models.map((model) => model.share)).toEqual([0.2, 0.5, 0.3]);
  });

  it("gives an unbacked model a null multiplier, never Infinity", () => {
    const odds = computePoolOdds({
      models: MODELS,
      stakesByModel: { a: 100 },
    });
    const beta = odds.models.find((model) => model.modelId === "b");

    expect(beta?.multiplier).toBeNull();
    expect(beta?.staked).toBe(0);
    expect(beta?.share).toBe(0);
  });

  it("gives every model a null multiplier when the pot is empty", () => {
    const odds = computePoolOdds({ models: MODELS, stakesByModel: {} });
    expect(odds.pot).toBe(0);
    expect(odds.models.every((model) => model.multiplier === null)).toBe(true);
    expect(odds.models.every((model) => model.share === 0)).toBe(true);
  });

  it("still lists every model in the given order", () => {
    const odds = computePoolOdds({
      models: MODELS,
      stakesByModel: { c: 50 },
    });
    expect(odds.models.map((model) => model.modelId)).toEqual(["a", "b", "c"]);
  });

  it("counts a stake on a delisted model toward the pot", () => {
    // `gone` is not in MODELS, but its points are still in the pool the winner's
    // backers split. Dropping it would overstate everyone's multiplier.
    const odds = computePoolOdds({
      models: MODELS,
      stakesByModel: { a: 100, gone: 400 },
    });
    expect(odds.pot).toBe(500);
    expect(odds.models[0].multiplier).toBe(5);
  });

  it("ignores non-positive and non-finite stake values", () => {
    const odds = computePoolOdds({
      models: MODELS,
      stakesByModel: { a: 100, b: 0, c: Number.NaN },
    });
    expect(odds.pot).toBe(100);
  });
});

describe("formatMultiplier", () => {
  it("formats a backed model", () => {
    expect(formatMultiplier(2)).toBe("2×");
    expect(formatMultiplier(3.3333)).toBe("3.33×");
  });

  it("renders an em dash for an unbacked model", () => {
    expect(formatMultiplier(null)).toBe("—");
    expect(formatMultiplier(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

/**
 * The draft board ("if you send this now").
 *
 * The board's rule is that the number on screen must be the number the pool
 * would hold the instant the stake landed — no more, no less. These tests pin the
 * two ways a naive implementation gets that wrong: it *adds* the draft to the
 * viewer's own stake (silently inflating the pot, because `place_stake` upserts
 * one stake per account) and it invents a price for an empty market.
 */
describe("computeDraftPricing", () => {
  const stakes = { a: 100, b: 250, c: 150 }; // pot 500

  it("prices each model by its share of the pool", () => {
    const pricing = computeDraftPricing({
      models: MODELS,
      stakesByModel: stakes,
      pickedModelId: null,
      points: 0,
    });

    expect(pricing.pot).toBe(500);
    expect(pricing.models.map((model) => model.percent)).toEqual([20, 50, 30]);
  });

  it("moves the price the moment a draft stake lands", () => {
    // Stake 250 on Alpha: pot 750, Alpha 350 -> 46.67%.
    const pricing = computeDraftPricing({
      models: MODELS,
      stakesByModel: stakes,
      pickedModelId: "a",
      points: 250,
    });

    expect(pricing.pot).toBe(750);
    expect(pricing.pickedPercent).toBe(46.67);
    expect(pricing.pickedDeltaPoints).toBe(26.67);
    // Buying into a side always thins the payout: 5× becomes 750/350.
    expect(pricing.pickedDeltaMultiplier).toBe(-2.86);
    // The rivals' money is unchanged and the pot grew, so they get cheaper.
    expect(pricing.models.find((model) => model.modelId === "b")?.percent).toBe(
      33.33,
    );
  });

  it("never reports a better payout for the side being bought", () => {
    // Sweep the stake: the chance rises and the multiplier falls, every time.
    for (const points of [10, 250, 1000, 5000]) {
      const pricing = computeDraftPricing({
        models: MODELS,
        stakesByModel: stakes,
        pickedModelId: "b",
        points,
      });
      expect(pricing.pickedDeltaPoints).toBeGreaterThan(0);
      expect(pricing.pickedDeltaMultiplier).toBeLessThanOrEqual(0);
    }
  });

  it("replaces the viewer's own stake instead of adding to it", () => {
    // The viewer already has 100 on Alpha; raising it to 250 is a replace.
    const pricing = computeDraftPricing({
      models: MODELS,
      stakesByModel: stakes,
      ownStake: { modelId: "a", points: 100 },
      pickedModelId: "a",
      points: 250,
    });

    expect(pricing.pot).toBe(650); // 500 - 100 + 250
    expect(pricing.models.find((model) => model.modelId === "a")?.staked).toBe(
      250,
    );
  });

  it("moves the viewer's own stake off the model it currently sits on", () => {
    const pricing = computeDraftPricing({
      models: MODELS,
      stakesByModel: stakes,
      ownStake: { modelId: "a", points: 100 },
      pickedModelId: "c",
      points: 100,
    });

    expect(pricing.pot).toBe(500); // same money, different side
    expect(pricing.models.map((model) => model.percent)).toEqual([0, 50, 50]);
  });

  it("prices an empty market at zero, never a made-up split", () => {
    const pricing = computeDraftPricing({
      models: MODELS,
      stakesByModel: {},
      pickedModelId: null,
      points: 0,
    });

    expect(pricing.pot).toBe(0);
    expect(pricing.models.every((model) => model.percent === 0)).toBe(true);
    expect(pricing.models.every((model) => model.multiplier === null)).toBe(
      true,
    );
  });

  it("prices the first stake into an empty pool at the whole pot", () => {
    // Nobody has disagreed yet, so the backer is the only side.
    const pricing = computeDraftPricing({
      models: MODELS,
      stakesByModel: {},
      pickedModelId: "b",
      points: 300,
    });

    expect(pricing.pickedPercent).toBe(100);
    expect(pricing.models.find((model) => model.modelId === "b")?.multiplier).toBe(
      1,
    );
  });

  it("ignores a draft with no pick and non-positive points", () => {
    const pricing = computeDraftPricing({
      models: MODELS,
      stakesByModel: stakes,
      pickedModelId: "a",
      points: -40,
    });

    expect(pricing.points).toBe(0);
    expect(pricing.pot).toBe(500);
  });
});
