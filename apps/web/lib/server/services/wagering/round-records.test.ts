import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/integrations/supabase/admin", () => ({
  getServiceRoleSupabase: vi.fn(),
}));
vi.mock("@/lib/server/integrations/solana/connection", () => ({
  getDevnetConnection: vi.fn(),
}));

import { closeMemo, roundMemo } from "./commitment";
import {
  checkRecord,
  expectedRecord,
  type RoundRowForRecords,
} from "./round-records";

// Synthetic fixtures; never rendered anywhere.
const ROUND_ID = "11111111-1111-4111-8111-111111111111";
const TREASURY = "BsLUuJUTHcfcysSYeb9cDCLsPzvP4UoAtMprzpgh1Lod";

const round = (
  overrides: Partial<RoundRowForRecords> = {},
): RoundRowForRecords => ({
  id: ROUND_ID,
  // Postgres renders timestamptz with an offset; the memo must be the same
  // instant in UTC.
  prediction_deadline: "2026-11-20T20:30:00+00:00",
  token_budget_per_model: 6144,
  cutoff_bps: 7500,
  fee_bps: 500,
  treasury_address: TREASURY,
  betting_closed_at: null,
  betting_close_reason: null,
  ...overrides,
});

describe("round record (F21)", () => {
  const memo = roundMemo({
    roundId: ROUND_ID,
    anteDeadline: "2026-11-20T20:30:00.000Z",
    budgetTokens: 6144,
    cutoffBps: 7500,
    feeBps: 500,
    treasury: TREASURY,
  });

  it("carries the round id and the deadline as an explicit UTC instant", () => {
    expect(memo).toContain(ROUND_ID);
    expect(memo).toContain("2026-11-20T20:30:00.000Z");
  });

  it("matches the round row it was written for", () => {
    expect(checkRecord("round_record", memo, round()).matchesRound).toBe(true);
  });

  it("treats a non-UTC rendering of the same instant as the same deadline", () => {
    const shifted = round({ prediction_deadline: "2026-11-20T14:30:00-06:00" });
    expect(checkRecord("round_record", memo, shifted).matchesRound).toBe(true);
  });

  it("detects a deadline that differs from the stored one", () => {
    const moved = round({ prediction_deadline: "2026-11-20T20:31:00+00:00" });
    expect(checkRecord("round_record", memo, moved).matchesRound).toBe(false);
  });

  it("detects a record written for another round", () => {
    const other = round({ id: "22222222-2222-4222-8222-222222222222" });
    expect(checkRecord("round_record", memo, other).matchesRound).toBe(false);
  });

  it("detects changed rules (fee, treasury)", () => {
    expect(
      checkRecord("round_record", memo, round({ fee_bps: 600 })).matchesRound,
    ).toBe(false);
    expect(
      checkRecord("round_record", memo, round({ treasury_address: "x" }))
        .matchesRound,
    ).toBe(false);
  });
});

describe("betting close record (F21)", () => {
  const closedAt = "2026-11-20T20:41:07.123456+00:00";
  const closed = round({
    betting_closed_at: closedAt,
    betting_close_reason: "token_threshold",
  });
  const memo = closeMemo({
    roundId: ROUND_ID,
    reason: "token_threshold",
    closedAt,
    snapshotHash: "a".repeat(64),
  });

  it("matches the stored close time and reason", () => {
    expect(checkRecord("betting_close", memo, closed).matchesRound).toBe(true);
  });

  it("detects a different close reason", () => {
    const other = { ...closed, betting_close_reason: "stall" };
    expect(checkRecord("betting_close", memo, other).matchesRound).toBe(false);
  });

  it("has nothing to compare before betting closes", () => {
    expect(expectedRecord("betting_close", round())).toBeNull();
    expect(checkRecord("betting_close", memo, round()).matchesRound).toBeNull();
  });
});
