import { describe, expect, it } from "vitest";

import { computePoolOdds, formatMultiplier } from "./odds";

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
