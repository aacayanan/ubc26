import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, NotFoundError } from "@/lib/server/errors/app-error";

/**
 * Settlement orchestration (F18).
 *
 * These pin the *decisions around* the pot math: which rounds may settle, that
 * an undecidable round writes nothing, and that the resolver's verdict plus the
 * computed payouts reach `settle_round` in one call. The transaction and the
 * idempotency latch live in the database and are covered by
 * `supabase/tests/f18_settlement.sql`.
 */

const mocks = vi.hoisted(() => ({
  loadRoundRunInputs: vi.fn(),
  listJudgeVerdicts: vi.fn(),
  getRenderedArtifact: vi.fn(),
  getRoundOutcome: vi.fn(),
  getCrowdVote: vi.fn(),
  rpc: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/server/services/pipeline/round-inputs", () => ({
  loadRoundRunInputs: mocks.loadRoundRunInputs,
}));
vi.mock("@/lib/server/services/pipeline/pipeline-persist", () => ({
  listJudgeVerdicts: mocks.listJudgeVerdicts,
}));
vi.mock("@/lib/server/services/evaluation/artifacts", () => ({
  getRenderedArtifact: mocks.getRenderedArtifact,
}));
vi.mock("@/lib/server/services/evaluation/outcomes-persist", () => ({
  getRoundOutcome: mocks.getRoundOutcome,
}));
vi.mock("@/lib/server/services/scoring/votes", () => ({
  getCrowdVote: mocks.getCrowdVote,
}));
vi.mock("@/lib/server/logging/logger", () => ({ logger: mocks.logger }));
vi.mock("@/lib/server/integrations/supabase/admin", () => ({
  getServiceRoleSupabase: () => fakeSupabase(),
}));

import { settleRound } from "@/lib/server/services/scoring/settlement";

const ROUND_ID = "11111111-1111-4111-8111-111111111111";

/** A fake client good enough for the round/exec/stake reads settlement makes. */
function fakeSupabase(roundStatus = "EVALUATING", stakes: unknown[] = []) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        order: self,
        limit: self,
        maybeSingle: () => {
          if (table === "rounds") {
            return Promise.resolve({
              data: { id: ROUND_ID, slug: "round-x", status: roundStatus },
              error: null,
            });
          }
          if (table === "model_executions") {
            return Promise.resolve({
              data: { id: `exec-${table}` },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        // predictions read: return the staked rows once, resolved via thenable.
        then: (resolve: (value: unknown) => void) => {
          if (table === "predictions") {
            resolve({ data: stakes, error: null });
          } else {
            resolve({ data: [], error: null });
          }
        },
      });
      return chain;
    },
    rpc: mocks.rpc,
  } as unknown as SupabaseClient;
}

function participant(id: string, ordinal: number, name = id) {
  return {
    id,
    slug: id,
    name,
    provider: "test",
    openrouterModelId: `org/${id}`,
    config: {},
    sortOrder: ordinal,
    role: "competitor" as const,
    ordinal,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRoundOutcome.mockResolvedValue(null);
  mocks.getCrowdVote.mockResolvedValue({ tally: { counts: {} }, votes: [] });
  mocks.rpc.mockResolvedValue({
    data: { alreadySettled: false, stakesSettled: 1, pointsCredited: 100 },
    error: null,
  });
});

describe("settleRound", () => {
  it("throws when the round does not exist", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(
      settleRound({ roundId: ROUND_ID, correlationId: "c", supabase: sb }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a round that is not EVALUATING", async () => {
    const sb = fakeSupabase("RUNNING");

    await expect(
      settleRound({ roundId: ROUND_ID, correlationId: "c", supabase: sb }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns the recorded outcome without writing when already final", async () => {
    mocks.getRoundOutcome.mockResolvedValue({
      kind: "settled",
      winnerModelId: "m1",
      fanFavoriteModelId: null,
      reason: "done",
    });

    const result = await settleRound({
      roundId: ROUND_ID,
      correlationId: "c",
      supabase: fakeSupabase("SETTLED"),
    });

    expect(result.status).toBe("already-final");
    expect(result.winnerModelId).toBe("m1");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("writes nothing when the round cannot be decided yet", async () => {
    mocks.loadRoundRunInputs.mockResolvedValue({
      roundId: ROUND_ID,
      slug: "round-x",
      status: "EVALUATING",
      brief: {},
      participants: [participant("a", 0), participant("b", 1)],
    });
    // 'a' ruled conformed; 'b' has a judge outage → retryable.
    mocks.listJudgeVerdicts.mockResolvedValue([
      { subjectModelId: "a", verdict: "conformed", reason: "ok", criteria: [] },
      {
        subjectModelId: "b",
        verdict: "unavailable",
        reason: "judge down",
        criteria: [],
      },
    ]);
    mocks.getRenderedArtifact.mockResolvedValue({
      executionId: "e",
      gatePassed: true,
      gateFailureReason: null,
      checks: [],
      frameCount: 3,
      frames: [],
      framesTruncated: false,
      unavailable: false,
    });

    const result = await settleRound({
      roundId: ROUND_ID,
      correlationId: "c",
      supabase: fakeSupabase("EVALUATING"),
    });

    expect(result.status).toBe("retryable");
    expect(result.stakesSettled).toBe(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("settles a sole conformer and passes the pot split to settle_round once", async () => {
    mocks.loadRoundRunInputs.mockResolvedValue({
      roundId: ROUND_ID,
      slug: "round-x",
      status: "EVALUATING",
      brief: {},
      participants: [participant("winner", 0), participant("loser", 1)],
    });
    mocks.listJudgeVerdicts.mockResolvedValue([
      {
        subjectModelId: "winner",
        verdict: "conformed",
        reason: "great",
        criteria: [],
      },
      {
        subjectModelId: "loser",
        verdict: "not_conformed",
        reason: "off brief",
        criteria: [],
      },
    ]);
    mocks.getRenderedArtifact.mockResolvedValue({
      executionId: "e",
      gatePassed: true,
      gateFailureReason: null,
      checks: [],
      frameCount: 3,
      frames: [],
      framesTruncated: false,
      unavailable: false,
    });

    const stakes = [
      {
        id: "p1",
        user_id: "u1",
        model_id: "winner",
        stake_points: 100,
        settled_at: null,
      },
      {
        id: "p2",
        user_id: "u2",
        model_id: "loser",
        stake_points: 100,
        settled_at: null,
      },
    ];

    const result = await settleRound({
      roundId: ROUND_ID,
      correlationId: "c",
      supabase: fakeSupabase("EVALUATING", stakes),
    });

    expect(result.status).toBe("settled");
    expect(result.winnerModelId).toBe("winner");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);

    const [, args] = mocks.rpc.mock.calls[0];
    expect(mocks.rpc.mock.calls[0][0]).toBe("settle_round");
    expect(args.p_kind).toBe("settled");
    expect(args.p_winner_model_id).toBe("winner");
    expect(args.p_tie_break).toBe("sole-conformer");

    // Pot 200, winning stake 100 → the backer doubles to 200, the loser gets 0.
    const rows = args.p_stakes as Array<{
      prediction_id: string;
      outcome: string;
      points_awarded: number;
    }>;
    expect(rows.find((r) => r.prediction_id === "p1")).toMatchObject({
      outcome: "won",
      points_awarded: 200,
    });
    expect(rows.find((r) => r.prediction_id === "p2")).toMatchObject({
      outcome: "lost",
      points_awarded: 0,
    });
  });

  it("voids the round when no model conformed and returns stakes as void", async () => {
    mocks.loadRoundRunInputs.mockResolvedValue({
      roundId: ROUND_ID,
      slug: "round-x",
      status: "EVALUATING",
      brief: {},
      participants: [participant("a", 0)],
    });
    mocks.listJudgeVerdicts.mockResolvedValue([
      {
        subjectModelId: "a",
        verdict: "not_conformed",
        reason: "off brief",
        criteria: [],
      },
    ]);
    mocks.getRenderedArtifact.mockResolvedValue({
      executionId: "e",
      gatePassed: true,
      gateFailureReason: null,
      checks: [],
      frameCount: 3,
      frames: [],
      framesTruncated: false,
      unavailable: false,
    });

    const result = await settleRound({
      roundId: ROUND_ID,
      correlationId: "c",
      supabase: fakeSupabase("EVALUATING", [
        {
          id: "p1",
          user_id: "u1",
          model_id: "a",
          stake_points: 100,
          settled_at: null,
        },
      ]),
    });

    expect(result.status).toBe("voided");
    const [, args] = mocks.rpc.mock.calls[0];
    expect(args.p_kind).toBe("voided");
    expect(args.p_winner_model_id).toBeNull();
    expect((args.p_stakes as Array<{ outcome: string }>)[0].outcome).toBe(
      "void",
    );
  });
});
