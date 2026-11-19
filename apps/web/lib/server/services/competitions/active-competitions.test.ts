import { describe, expect, it } from "vitest";

import { isActiveCompetition } from "./active-competitions";

/**
 * F9: only actionable rounds are listed.
 *
 * `getActiveCompetitions` itself reads the database; this pins the predicate that
 * decides eligibility, which is the part with rules in it. The distinction it
 * enforces is the one that matters: `OPEN` is the lifecycle state, but a round
 * whose deadline has passed is not joinable, and F11 may not have locked it yet.
 */
describe("isActiveCompetition", () => {
  const now = new Date("2026-11-19T12:00:00Z");

  const round = (
    overrides: Partial<Parameters<typeof isActiveCompetition>[0]>,
  ) => ({
    status: "OPEN",
    prediction_opens_at: "2026-11-19T00:00:00Z",
    prediction_deadline: "2026-11-20T00:00:00Z",
    ...overrides,
  });

  it("accepts an OPEN round inside its staking window", () => {
    expect(isActiveCompetition(round({}), now)).toBe(true);
  });

  it("accepts an OPEN round with no explicit opening time", () => {
    expect(isActiveCompetition(round({ prediction_opens_at: null }), now)).toBe(
      true,
    );
  });

  it("rejects an OPEN round whose deadline has passed", () => {
    expect(
      isActiveCompetition(
        round({ prediction_deadline: "2026-11-19T11:00:00Z" }),
        now,
      ),
    ).toBe(false);
  });

  it("rejects an OPEN round whose deadline is exactly now", () => {
    expect(
      isActiveCompetition(
        round({ prediction_deadline: "2026-11-19T12:00:00Z" }),
        now,
      ),
    ).toBe(false);
  });

  it("rejects an OPEN round that has not opened yet", () => {
    expect(
      isActiveCompetition(
        round({ prediction_opens_at: "2026-11-19T13:00:00Z" }),
        now,
      ),
    ).toBe(false);
  });

  it("rejects an unparseable deadline rather than guessing", () => {
    expect(
      isActiveCompetition(round({ prediction_deadline: "not-a-date" }), now),
    ).toBe(false);
  });

  it("rejects an unparseable opening time", () => {
    expect(
      isActiveCompetition(round({ prediction_opens_at: "not-a-date" }), now),
    ).toBe(false);
  });

  it.each([
    "LOCKED",
    "RUNNING",
    "EVALUATING",
    "SETTLED",
    "VOIDED",
    "CANCELLED",
  ])("rejects a %s round even inside its window", (status) => {
    expect(isActiveCompetition(round({ status }), now)).toBe(false);
  });
});
