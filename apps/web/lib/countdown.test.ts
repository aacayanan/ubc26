import { describe, expect, it } from "vitest";

import {
  URGENT_THRESHOLD_MS,
  describeDeadline,
  formatCountdown,
  getCountdown,
} from "./countdown";

/**
 * F9 acceptance: "countdown handles refresh and deadline passage correctly".
 *
 * Everything here is a pure function of (deadline, now), which is the property
 * that makes refresh correct: there is no mounting offset to lose. These tests
 * pin the arithmetic and, more importantly, the *edges* — a countdown that reads
 * zero while time remains, or that stays green after expiry, would mislead a
 * user about whether they can still stake.
 */

const NOW = new Date("2026-11-19T12:00:00Z");

describe("getCountdown", () => {
  it("measures remaining time from the absolute deadline", () => {
    const result = getCountdown("2026-11-19T12:01:30Z", NOW);
    expect(result).toEqual({
      remainingMs: 90_000,
      expired: false,
      invalid: false,
    });
  });

  it("is expired at the deadline exactly", () => {
    const result = getCountdown("2026-11-19T12:00:00Z", NOW);
    expect(result.expired).toBe(true);
    expect(result.remainingMs).toBe(0);
  });

  it("clamps a past deadline to zero remaining", () => {
    const result = getCountdown("2026-11-19T09:00:00Z", NOW);
    expect(result.expired).toBe(true);
    expect(result.remainingMs).toBe(0);
  });

  it("treats a missing deadline as expired and invalid", () => {
    expect(getCountdown(null, NOW)).toEqual({
      remainingMs: 0,
      expired: true,
      invalid: true,
    });
  });

  it("treats an unparseable deadline as expired and invalid", () => {
    expect(getCountdown("tomorrow-ish", NOW)).toEqual({
      remainingMs: 0,
      expired: true,
      invalid: true,
    });
  });

  it("accepts a Date as well as an ISO string", () => {
    expect(
      getCountdown(new Date("2026-11-19T12:00:10Z"), NOW).remainingMs,
    ).toBe(10_000);
  });
});

describe("formatCountdown", () => {
  it("shows minutes and seconds under an hour", () => {
    expect(formatCountdown(4 * 60_000 + 7_000)).toBe("4:07");
  });

  it("shows hours once there is an hour left", () => {
    expect(formatCountdown(4 * 3600_000 + 31 * 60_000 + 7_000)).toBe(
      "04:31:07",
    );
  });

  it("shows days once there is a day left", () => {
    expect(
      formatCountdown(2 * 86_400_000 + 4 * 3600_000 + 31 * 60_000 + 7_000),
    ).toBe("2d 04:31:07");
  });

  it("rounds partial seconds up, so it only reads zero when time is gone", () => {
    expect(formatCountdown(1)).toBe("0:01");
    expect(formatCountdown(999)).toBe("0:01");
    expect(formatCountdown(1000)).toBe("0:01");
    expect(formatCountdown(1001)).toBe("0:02");
  });

  it("reads 0:00 only at and past zero", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5_000)).toBe("0:00");
  });

  it("does not crash on a non-finite value", () => {
    expect(formatCountdown(Number.NaN)).toBe("0:00");
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});

describe("describeDeadline", () => {
  it("labels a live deadline with its digits", () => {
    const result = describeDeadline("2026-11-19T12:44:07Z", NOW);
    expect(result.text).toBe("44:07");
    expect(result.expired).toBe(false);
    expect(result.urgent).toBe(false);
  });

  it("marks the last five minutes urgent", () => {
    // Exclusive at the boundary: 5:00 exactly is not yet urgent.
    expect(describeDeadline("2026-11-19T12:05:00Z", NOW).urgent).toBe(true);
    expect(describeDeadline("2026-11-19T12:05:01Z", NOW).urgent).toBe(false);
  });

  it("never marks an expired deadline urgent", () => {
    expect(describeDeadline("2026-11-19T12:00:00Z", NOW).urgent).toBe(false);
  });

  it("says Locked once the deadline passes", () => {
    expect(describeDeadline("2026-11-19T11:00:00Z", NOW).text).toBe("Locked");
  });

  it("says the deadline is unavailable rather than showing a number", () => {
    const result = describeDeadline(null, NOW);
    expect(result.text).toBe("Deadline unavailable");
    expect(result.invalid).toBe(true);
  });

  it("exposes the urgent threshold the UI is built on", () => {
    expect(URGENT_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });
});
