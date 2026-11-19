import { describe, expect, it } from "vitest";

import {
  displayStateHeadline,
  modelStatusWord,
  resolveDisplayState,
} from "./display";

/**
 * F19: how a stored outcome reads.
 *
 * These pin the distinctions the results page must never blur — a void is not a
 * win, "every model forfeited" is not the same story as "no model conformed",
 * and an undecided round is never shown as decided.
 */

const settled = {
  kind: "settled" as const,
  winnerModelId: "m1",
  tieBreak: "sole-conformer",
  allForfeited: false,
};

describe("resolveDisplayState", () => {
  it("is pending while the round has not locked", () => {
    expect(
      resolveDisplayState({ status: "OPEN", outcome: null, modelStatuses: [] }),
    ).toBe("pending");
    expect(
      resolveDisplayState({ status: "RUNNING", outcome: null, modelStatuses: [] }),
    ).toBe("pending");
  });

  it("reports judge-unavailable for an undecided round whose judge failed", () => {
    expect(
      resolveDisplayState({
        status: "EVALUATING",
        outcome: null,
        modelStatuses: ["conformed", "unavailable"],
      }),
    ).toBe("judge-unavailable");
  });

  it("is winner for a settled sole conformer", () => {
    expect(
      resolveDisplayState({
        status: "SETTLED",
        outcome: settled,
        modelStatuses: ["conformed"],
      }),
    ).toBe("winner");
  });

  it("is a tie when the tie was broken by the crowd vote or order", () => {
    expect(
      resolveDisplayState({
        status: "SETTLED",
        outcome: { ...settled, tieBreak: "crowd-vote" },
        modelStatuses: ["conformed", "conformed"],
      }),
    ).toBe("tie");
    expect(
      resolveDisplayState({
        status: "SETTLED",
        outcome: { ...settled, tieBreak: "stable-order" },
        modelStatuses: ["conformed", "conformed"],
      }),
    ).toBe("tie");
  });

  it("is all-forfeited for a void where every model forfeited", () => {
    expect(
      resolveDisplayState({
        status: "VOIDED",
        outcome: {
          kind: "voided",
          winnerModelId: null,
          tieBreak: null,
          allForfeited: true,
        },
        modelStatuses: ["forfeited", "forfeited", "forfeited"],
      }),
    ).toBe("all-forfeited");
  });

  it("is no-conformer for a void where models rendered but none conformed", () => {
    expect(
      resolveDisplayState({
        status: "VOIDED",
        outcome: {
          kind: "voided",
          winnerModelId: null,
          tieBreak: null,
          allForfeited: false,
        },
        modelStatuses: ["not_conformed", "not_conformed", "forfeited"],
      }),
    ).toBe("no-conformer");
  });

  it("reads a decided round with no outcome row as a void, never a win", () => {
    expect(
      resolveDisplayState({
        status: "SETTLED",
        outcome: null,
        modelStatuses: [],
      }),
    ).toBe("voided");
  });

  it("treats ARCHIVED as decided, honouring the recorded outcome", () => {
    expect(
      resolveDisplayState({
        status: "ARCHIVED",
        outcome: settled,
        modelStatuses: ["conformed"],
      }),
    ).toBe("winner");
  });
});

describe("modelStatusWord", () => {
  it("never uses amber", () => {
    for (const status of [
      "conformed",
      "not_conformed",
      "forfeited",
      "unavailable",
      "pending",
    ]) {
      expect(modelStatusWord(status).tone).not.toBe("amber");
    }
  });

  it("labels the conformance vocabulary", () => {
    expect(modelStatusWord("conformed").label).toBe("Conformed");
    expect(modelStatusWord("not_conformed").label).toBe("Off brief");
    expect(modelStatusWord("forfeited").label).toBe("Forfeited");
    expect(modelStatusWord("unavailable").label).toBe("Judge unavailable");
  });
});

describe("displayStateHeadline", () => {
  it("has a headline for every state", () => {
    for (const state of [
      "winner",
      "tie",
      "all-forfeited",
      "no-conformer",
      "judge-unavailable",
      "voided",
      "pending",
    ] as const) {
      expect(displayStateHeadline(state).length).toBeGreaterThan(0);
    }
  });
});
