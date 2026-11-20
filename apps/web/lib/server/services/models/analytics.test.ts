import { describe, expect, it } from "vitest";

import { RECENT_ROUNDS_PER_MODEL, aggregateModelHistory } from "./analytics";

/**
 * Historical model performance (F25).
 *
 * The rules worth pinning are the ones a naive implementation gets wrong:
 *
 *   * a void or a failed round must not be silently dropped — it is counted and
 *     labeled, but kept out of both rates' denominators;
 *   * `unavailable` is a judge outage, not a ruling, so it never counts as a
 *     non-conformance (F15: never settled on a guess);
 *   * conformance and crowd are computed over different denominators on
 *     purpose — conformance over the rounds actually judged, crowd over every
 *     settled round (a round with no votes is a real miss);
 *   * the output order and `recent` do not depend on the input order.
 */

const MODEL_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const MODEL_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const MODEL_C = "cccccccc-0000-4000-8000-00000000000c";

const names = new Map([
  [MODEL_A, "Model A"],
  [MODEL_B, "Model B"],
  [MODEL_C, "Model C"],
]);

let day = 0;
function round(overrides: {
  model_id: string;
  outcome?: "settled" | "voided" | "unsettled";
  conformance?:
    "conformed" | "not_conformed" | "forfeited" | "unavailable" | null;
  winner_model_id?: string | null;
  fan_favorite_model_id?: string | null;
  round_id?: string;
  decided_at?: string;
}) {
  day += 1;
  return {
    model_id: overrides.model_id,
    round_id: overrides.round_id ?? `round-${day}`,
    round_slug: `round-${day}`,
    brief_title: "A brief",
    outcome: overrides.outcome ?? "settled",
    conformance: overrides.conformance ?? null,
    winner_model_id: overrides.winner_model_id ?? null,
    fan_favorite_model_id: overrides.fan_favorite_model_id ?? null,
    decided_at:
      overrides.decided_at ??
      `2026-11-${String(day).padStart(2, "0")}T00:00:00Z`,
  };
}

describe("aggregateModelHistory", () => {
  it("returns one history per model, named from the catalog", () => {
    const histories = aggregateModelHistory(
      [
        round({ model_id: MODEL_A, conformance: "conformed" }),
        round({ model_id: MODEL_B, conformance: "not_conformed" }),
      ],
      names,
    );

    expect(histories).toHaveLength(2);
    expect(histories.map((h) => h.name).sort()).toEqual(["Model A", "Model B"]);
  });

  it("counts conformance, round wins and crowd wins separately", () => {
    const [history] = aggregateModelHistory(
      [
        round({
          model_id: MODEL_A,
          conformance: "conformed",
          winner_model_id: MODEL_A,
          fan_favorite_model_id: MODEL_A,
        }),
        round({ model_id: MODEL_A, conformance: "not_conformed" }),
        round({
          model_id: MODEL_A,
          conformance: "conformed",
          winner_model_id: MODEL_A,
        }),
      ],
      names,
    );

    expect(history.settledRounds).toBe(3);
    expect(history.conformanceWins).toBe(2);
    expect(history.roundWins).toBe(2);
    expect(history.crowdWins).toBe(1);
    expect(history.conformanceRate).toBeCloseTo(2 / 3);
    // Crowd rate is over every settled round: 1 pick out of 3 chances.
    expect(history.crowdWinRate).toBeCloseTo(1 / 3);
  });

  it("excludes voids and failed rounds from both denominators but counts them", () => {
    const [history] = aggregateModelHistory(
      [
        round({ model_id: MODEL_A, conformance: "conformed" }),
        round({ model_id: MODEL_A, outcome: "voided" }),
        round({ model_id: MODEL_A, outcome: "unsettled" }),
      ],
      names,
    );

    expect(history.rounds).toBe(3);
    expect(history.settledRounds).toBe(1);
    expect(history.voidedRounds).toBe(1);
    expect(history.unsettledRounds).toBe(1);
    // Rates see only the one settled round — the void does not drag the rate down.
    expect(history.conformanceRate).toBe(1);
    expect(history.crowdWinRate).toBe(0);
  });

  it("treats an unavailable judge as not-a-ruling, not a non-conformance", () => {
    const [history] = aggregateModelHistory(
      [
        round({ model_id: MODEL_A, conformance: "conformed" }),
        round({ model_id: MODEL_A, conformance: "unavailable" }),
      ],
      names,
    );

    // Two settled rounds, but only one was actually ruled on.
    expect(history.settledRounds).toBe(2);
    expect(history.conformanceWins).toBe(1);
    expect(history.conformanceRate).toBe(1);
  });

  it("counts forfeits without putting them in the conformance denominator", () => {
    const [history] = aggregateModelHistory(
      [
        round({ model_id: MODEL_A, conformance: "conformed" }),
        round({ model_id: MODEL_A, conformance: "forfeited" }),
      ],
      names,
    );

    expect(history.forfeits).toBe(1);
    // A forfeit is not judged, so it does not count as "did not conform".
    expect(history.conformanceRate).toBe(1);
  });

  it("reports null rates for a model with no judged or settled rounds", () => {
    const [history] = aggregateModelHistory(
      [round({ model_id: MODEL_A, outcome: "voided" })],
      names,
    );

    expect(history.settledRounds).toBe(0);
    expect(history.conformanceRate).toBeNull();
    expect(history.crowdWinRate).toBeNull();
  });

  it("keeps recent rounds newest-first and capped, regardless of input order", () => {
    const rows = Array.from({ length: RECENT_ROUNDS_PER_MODEL + 4 }, (_, i) =>
      round({
        model_id: MODEL_A,
        round_id: `r-${i}`,
        decided_at: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    ).reverse();

    const [history] = aggregateModelHistory(rows, names);

    expect(history.recent).toHaveLength(RECENT_ROUNDS_PER_MODEL);
    // The newest decided round leads.
    expect(history.recent[0].roundId).toBe(`r-${RECENT_ROUNDS_PER_MODEL + 3}`);
    const times = history.recent.map((r) => Date.parse(r.decidedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("orders models by settled rounds, then conformance, then name", () => {
    const histories = aggregateModelHistory(
      [
        // B settles once; A settles twice and conforms; C settles twice once.
        round({ model_id: MODEL_B, conformance: "conformed" }),
        round({ model_id: MODEL_A, conformance: "conformed" }),
        round({ model_id: MODEL_A, conformance: "conformed" }),
        round({ model_id: MODEL_C, conformance: "conformed" }),
        round({ model_id: MODEL_C, conformance: "not_conformed" }),
      ],
      names,
    );

    expect(histories.map((h) => h.name)).toEqual([
      "Model A",
      "Model C",
      "Model B",
    ]);
  });

  it("falls back to a readable name when the catalog row is missing", () => {
    const [history] = aggregateModelHistory(
      [round({ model_id: MODEL_C, conformance: "conformed" })],
      new Map(),
    );

    expect(history.name).toBe("Unknown model");
  });
});
