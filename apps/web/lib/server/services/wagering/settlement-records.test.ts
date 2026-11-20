import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/integrations/supabase/admin", () => ({
  getServiceRoleSupabase: vi.fn(),
}));
vi.mock("@/lib/server/integrations/solana/connection", () => ({
  getDevnetConnection: vi.fn(),
}));

import { legacySettleMemo, settleMemo } from "./commitment";
import {
  checkRecord,
  checkSettlementOutcome,
  settlementMemos,
  type OutcomeFacts,
  type RoundRowForRecords,
  type SolSettlementRow,
} from "./round-records";

// Synthetic fixtures; never rendered anywhere.
const ROUND_ID = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const paid: SolSettlementRow = {
  kind: "settled",
  reason: "settled",
  winnerModelIds: [A],
  grossLamports: "170538265",
  feeLamports: "8526913",
  netLamports: "162011352",
  payoutCount: 2,
};

const refund = (reason: string): SolSettlementRow => ({
  kind: "refund",
  reason,
  winnerModelIds: [],
  grossLamports: "140607470",
  feeLamports: "0",
  netLamports: "140607470",
  payoutCount: 2,
});

const round = (settlement: SolSettlementRow): RoundRowForRecords => ({
  id: ROUND_ID,
  prediction_deadline: "2026-11-20T20:30:00+00:00",
  token_budget_per_model: 6144,
  cutoff_bps: 7500,
  fee_bps: 500,
  treasury_address: "x",
  betting_closed_at: null,
  betting_close_reason: null,
  sol_settlement: settlement,
});

const facts = (overrides: Partial<OutcomeFacts> = {}): OutcomeFacts => ({
  outcomeKind: "settled",
  outcomeWinnerId: A,
  conformedModelIds: [A],
  ...overrides,
});

describe("settlement memo (F22)", () => {
  it("carries summary facts only: kind, reason, winners, gross, fee, net, payout count", () => {
    const memo = settlementMemos(ROUND_ID, paid)[0];
    expect(memo).toBe(
      `aisd:v2:settle:${ROUND_ID}:settled:settled:${A}:170538265:8526913:162011352:2`,
    );
  });

  it("records a void as a void, not as a winner", () => {
    const memo = settlementMemos(ROUND_ID, refund("voided"))[0];
    expect(memo).toContain(":refund:voided:none:");
  });

  it("matches the stored settlement it was written for", () => {
    const memo = settleMemo({
      roundId: ROUND_ID,
      kind: "settled",
      reason: "settled",
      winners: [A],
      gross: "170538265",
      fee: "8526913",
      net: "162011352",
      payoutCount: 2,
    });
    expect(checkRecord("settlement", memo, round(paid)).matchesRound).toBe(
      true,
    );
  });

  it("still accepts records published in the earlier format", () => {
    const old = legacySettleMemo({
      roundId: ROUND_ID,
      kind: "refund",
      winners: [],
      gross: "140607470",
      fee: "0",
      net: "140607470",
      payoutCount: 2,
    });
    expect(
      checkRecord("settlement", old, round(refund("voided"))).matchesRound,
    ).toBe(true);
  });

  it("detects a memo that disagrees with the stored settlement", () => {
    const restated = settlementMemos(ROUND_ID, {
      ...paid,
      feeLamports: "1",
    })[0];
    expect(checkRecord("settlement", restated, round(paid)).matchesRound).toBe(
      false,
    );
  });
});

describe("checkSettlementOutcome (F22)", () => {
  it("accepts a payout to backers of the conforming model", () => {
    expect(checkSettlementOutcome(paid, facts()).ok).toBe(true);
  });

  it("accepts a dead heat when every winner conformed", () => {
    const heat = { ...paid, reason: "dead_heat", winnerModelIds: [A, B] };
    expect(
      checkSettlementOutcome(heat, facts({ conformedModelIds: [A, B] })).ok,
    ).toBe(true);
  });

  it("rejects a payout to a model that did not conform", () => {
    expect(
      checkSettlementOutcome(
        { ...paid, winnerModelIds: [B] },
        facts({ conformedModelIds: [A] }),
      ).ok,
    ).toBe(false);
  });

  it("rejects a payout when the round's outcome was a void", () => {
    expect(
      checkSettlementOutcome(
        paid,
        facts({ outcomeKind: "voided", outcomeWinnerId: null }),
      ).ok,
    ).toBe(false);
  });

  it("accepts a void refund for a voided or cancelled round", () => {
    const voided = facts({
      outcomeKind: "voided",
      outcomeWinnerId: null,
      conformedModelIds: [],
    });
    expect(checkSettlementOutcome(refund("voided"), voided).ok).toBe(true);
    const cancelled = facts({
      outcomeKind: null,
      outcomeWinnerId: null,
      conformedModelIds: [],
    });
    expect(checkSettlementOutcome(refund("voided"), cancelled).ok).toBe(true);
  });

  it("rejects a void refund when the round actually settled", () => {
    expect(checkSettlementOutcome(refund("voided"), facts()).ok).toBe(false);
  });

  it("checks no_winner and winner_unbacked against the conformance results", () => {
    const none = facts({ conformedModelIds: [] });
    expect(checkSettlementOutcome(refund("no_winner"), none).ok).toBe(true);
    expect(checkSettlementOutcome(refund("no_winner"), facts()).ok).toBe(false);
    expect(checkSettlementOutcome(refund("winner_unbacked"), facts()).ok).toBe(
      true,
    );
    expect(checkSettlementOutcome(refund("winner_unbacked"), none).ok).toBe(
      false,
    );
  });

  it("rejects a refund that names a winner", () => {
    expect(
      checkSettlementOutcome(
        { ...refund("winner_unbacked"), winnerModelIds: [A] },
        facts(),
      ).ok,
    ).toBe(false);
  });
});
