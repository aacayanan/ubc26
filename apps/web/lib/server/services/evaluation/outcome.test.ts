import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/server/errors/app-error";
import {
  classifyModelOutcome,
  isEligibleForFanFavorite,
  resolveRoundOutcome,
  type ModelConformance,
  type ModelOutcomeInput,
} from "@/lib/server/services/evaluation/outcome";

/**
 * F15 unit tests.
 *
 * Each acceptance criterion maps to a block below: every failure path has a
 * status and a plain-language reason, a tie never produces a nondeterministic
 * winner, and a void returns stakes rather than keeping them.
 */

function model(
  id: string,
  conformance: ModelConformance,
  options: { ordinal?: number; name?: string; reason?: string } = {},
): ModelOutcomeInput {
  return {
    modelId: id,
    name: options.name ?? id.toUpperCase(),
    ordinal: options.ordinal ?? 0,
    conformance,
    reason: options.reason ?? `reason for ${id}`,
  };
}

describe("classifyModelOutcome — every failure path has a status and a reason", () => {
  const passedGate = {
    passed: true,
    unavailable: false,
    failureReason: null,
  };

  it("a failed gate is a forfeit, never a judgeable render", () => {
    const outcome = classifyModelOutcome({
      gate: {
        passed: false,
        unavailable: false,
        failureReason: "The render exceeded the wall-clock limit.",
      },
      judge: null,
    });
    expect(outcome.conformance).toBe("forfeited");
    expect(outcome.reason).toMatch(/wall-clock/);
  });

  it("a render that threw is a forfeit with the thrown reason", () => {
    const outcome = classifyModelOutcome({
      gate: {
        passed: false,
        unavailable: false,
        failureReason: "The page threw an uncaught error: TypeError: boom",
      },
      judge: null,
    });
    expect(outcome.conformance).toBe("forfeited");
    expect(outcome.reason).toContain("boom");
  });

  it("a failed gate never reaches the judge, even if one ruled", () => {
    // The ordering rule: a gate failure is decisive. A rogue/stale judge verdict
    // must not rescue it.
    const outcome = classifyModelOutcome({
      gate: {
        passed: false,
        unavailable: false,
        failureReason: "Frames are 640x480; the brief requires 320x240.",
      },
      judge: { kind: "ruled", conformed: true, reason: "Looks fine." },
    });
    expect(outcome.conformance).toBe("forfeited");
  });

  it("an unavailable sandbox is unavailable infrastructure, not a forfeit", () => {
    const outcome = classifyModelOutcome({
      gate: {
        passed: false,
        unavailable: true,
        failureReason: "The render sandbox was unavailable.",
      },
      judge: null,
    });
    expect(outcome.conformance).toBe("unavailable");
  });

  it("a gate pass with no judge ruling yet is pending, not a guess", () => {
    const outcome = classifyModelOutcome({ gate: passedGate, judge: null });
    expect(outcome.conformance).toBe("pending");
    expect(outcome.reason).toMatch(/has not ruled/);
  });

  it("a judge API failure is unavailable, and the round must not settle on it", () => {
    const outcome = classifyModelOutcome({
      gate: passedGate,
      judge: { kind: "unavailable", reason: "provider returned 503" },
    });
    expect(outcome.conformance).toBe("unavailable");
    expect(outcome.reason).toContain("503");
  });

  it("a gate pass the judge rejects is not_conformed, not a forfeit", () => {
    const outcome = classifyModelOutcome({
      gate: passedGate,
      judge: { kind: "ruled", conformed: false, reason: "No donut visible." },
    });
    expect(outcome.conformance).toBe("not_conformed");
    expect(outcome.reason).toContain("donut");
  });

  it("a conforming ruling is conformance", () => {
    const outcome = classifyModelOutcome({
      gate: passedGate,
      judge: { kind: "ruled", conformed: true, reason: "A donut spins." },
    });
    expect(outcome.conformance).toBe("conformed");
  });
});

describe("isEligibleForFanFavorite — the scoring split", () => {
  it("a gate-passing render is eligible even when the judge rejected it", () => {
    expect(isEligibleForFanFavorite("conformed")).toBe(true);
    expect(isEligibleForFanFavorite("not_conformed")).toBe(true);
  });

  it("a forfeit, an outage and a pending model are never eligible", () => {
    expect(isEligibleForFanFavorite("forfeited")).toBe(false);
    expect(isEligibleForFanFavorite("unavailable")).toBe(false);
    expect(isEligibleForFanFavorite("pending")).toBe(false);
  });
});

describe("resolveRoundOutcome", () => {
  it("a sole conformer settles without a tie to break", () => {
    const resolution = resolveRoundOutcome([
      model("a", "conformed", { ordinal: 1 }),
      model("b", "forfeited", { ordinal: 2 }),
      model("c", "not_conformed", { ordinal: 3 }),
    ]);
    expect(resolution.kind).toBe("settled");
    if (resolution.kind !== "settled") return;
    expect(resolution.winnerModelId).toBe("a");
    expect(resolution.tieBreak).toBe("sole-conformer");
    // Nobody voted, so there is no fan favorite to record — inventing one would
    // be a fabricated outcome.
    expect(resolution.fanFavoriteModelId).toBeNull();
  });

  it("a sole conformer still records the crowd's fan favorite when votes exist", () => {
    const resolution = resolveRoundOutcome(
      [
        model("a", "conformed", { ordinal: 1 }),
        model("b", "forfeited", { ordinal: 2 }),
        model("c", "not_conformed", { ordinal: 3 }),
      ],
      { counts: { c: 4 } },
    );
    expect(resolution.kind).toBe("settled");
    if (resolution.kind !== "settled") return;
    // The gate-passing non-conformer is fan-favorite eligible; the forfeit is not.
    expect(resolution.fanFavoriteModelId).toBe("c");
  });

  it("every model forfeiting voids the round with the all-forfeited reason", () => {
    const resolution = resolveRoundOutcome([
      model("a", "forfeited", { ordinal: 1 }),
      model("b", "forfeited", { ordinal: 2 }),
      model("c", "forfeited", { ordinal: 3 }),
    ]);
    expect(resolution.kind).toBe("voided");
    expect(resolution.reason).toMatch(/every model forfeited/i);
    expect(resolution.reason).toMatch(/stakes are returned/i);
  });

  it("no conformer without a full forfeit still voids, with a distinct reason", () => {
    const resolution = resolveRoundOutcome([
      model("a", "forfeited", { ordinal: 1 }),
      model("b", "not_conformed", { ordinal: 2 }),
    ]);
    expect(resolution.kind).toBe("voided");
    expect(resolution.reason).toMatch(/no model conformed/i);
    expect(resolution.reason).not.toMatch(/every model forfeited/i);
  });

  it("an unavailable model makes the round retryable, not settled", () => {
    const resolution = resolveRoundOutcome([
      model("a", "conformed", { ordinal: 1 }),
      model("b", "unavailable", { ordinal: 2 }),
    ]);
    expect(resolution.kind).toBe("retryable");
    if (resolution.kind !== "retryable") return;
    expect(resolution.unavailableModelIds).toEqual(["b"]);
    expect(resolution.reason).toMatch(/retried rather than settled/i);
  });

  it("a pending model makes the round incomplete", () => {
    const resolution = resolveRoundOutcome([
      model("a", "conformed", { ordinal: 1 }),
      model("b", "pending", { ordinal: 2 }),
    ]);
    expect(resolution.kind).toBe("incomplete");
    if (resolution.kind !== "incomplete") return;
    expect(resolution.awaitingModelIds).toEqual(["b"]);
    // Only the decided model produces a recordable row.
    expect(resolution.results.map((r) => r.modelId)).toEqual(["a"]);
  });

  it("equal conformance is broken by the crowd's fan-favorite vote", () => {
    const resolution = resolveRoundOutcome(
      [
        model("a", "conformed", { ordinal: 1 }),
        model("b", "conformed", { ordinal: 2 }),
      ],
      { counts: { a: 3, b: 9 } },
    );
    expect(resolution.kind).toBe("settled");
    if (resolution.kind !== "settled") return;
    expect(resolution.winnerModelId).toBe("b");
    expect(resolution.tieBreak).toBe("crowd-vote");
    expect(resolution.reason).toMatch(/crowd voted/i);
  });

  it("a tied vote resolves deterministically by round order, and says so", () => {
    const resolution = resolveRoundOutcome(
      [
        model("b", "conformed", { ordinal: 2, name: "B" }),
        model("a", "conformed", { ordinal: 1, name: "A" }),
      ],
      { counts: { a: 5, b: 5 } },
    );
    expect(resolution.kind).toBe("settled");
    if (resolution.kind !== "settled") return;
    // Ordinal 1 wins the tied vote, regardless of input array order.
    expect(resolution.winnerModelId).toBe("a");
    expect(resolution.tieBreak).toBe("stable-order");
    expect(resolution.reason).toMatch(/round order decides/i);
  });

  it("is deterministic — reordering the input never changes the winner", () => {
    const inputs = [
      model("a", "conformed", { ordinal: 1 }),
      model("b", "conformed", { ordinal: 2 }),
      model("c", "conformed", { ordinal: 3 }),
    ];
    const votes = { counts: { a: 4, b: 4, c: 4 } };
    const first = resolveRoundOutcome(inputs, votes);
    const reversed = resolveRoundOutcome([...inputs].reverse(), votes);
    expect(first).toEqual(reversed);
    if (first.kind !== "settled") return;
    expect(first.winnerModelId).toBe("a");
  });

  it("a tie with no votes still names a deterministic winner", () => {
    const resolution = resolveRoundOutcome([
      model("a", "conformed", { ordinal: 1 }),
      model("b", "conformed", { ordinal: 2 }),
    ]);
    expect(resolution.kind).toBe("settled");
    if (resolution.kind !== "settled") return;
    expect(resolution.winnerModelId).toBe("a");
    expect(resolution.reason).toMatch(/no crowd votes/i);
    expect(resolution.fanFavoriteModelId).toBeNull();
  });

  it("prefers a gate-passing non-conformer as fan favorite over a forfeit", () => {
    // Fan-favorite eligibility is the deterministic gate, not the judge ruling.
    const resolution = resolveRoundOutcome(
      [
        model("a", "conformed", { ordinal: 1 }),
        model("b", "forfeited", { ordinal: 2 }),
        model("c", "not_conformed", { ordinal: 3 }),
      ],
      { counts: { a: 1, b: 100, c: 2 } },
    );
    expect(resolution.kind).toBe("settled");
    if (resolution.kind !== "settled") return;
    expect(resolution.fanFavoriteModelId).toBe("c");
  });

  it("records one result row per model on both a settle and a void", () => {
    const settled = resolveRoundOutcome([
      model("a", "conformed", { ordinal: 1 }),
      model("b", "forfeited", { ordinal: 2 }),
    ]);
    const voided = resolveRoundOutcome([
      model("a", "forfeited", { ordinal: 1 }),
    ]);
    expect(settled.results).toHaveLength(2);
    expect(settled.results.every((r) => typeof r.reason === "string")).toBe(
      true,
    );
    expect(voided.results).toHaveLength(1);
    expect(voided.results[0].status).toBe("forfeited");
  });

  it("rejects a round with no models", () => {
    expect(() => resolveRoundOutcome([])).toThrow(ValidationError);
  });

  it("rejects a duplicate model rather than double-counting it", () => {
    expect(() =>
      resolveRoundOutcome([
        model("a", "conformed", { ordinal: 1 }),
        model("a", "conformed", { ordinal: 1 }),
      ]),
    ).toThrow(/more than once/);
  });

  it("rejects a malformed vote tally", () => {
    expect(() =>
      resolveRoundOutcome([model("a", "conformed")], {
        counts: { a: -1 },
      }),
    ).toThrow(ValidationError);
  });
});
