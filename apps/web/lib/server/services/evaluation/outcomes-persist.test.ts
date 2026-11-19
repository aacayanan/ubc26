import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, InternalError } from "@/lib/server/errors/app-error";
import {
  CONFORMANCE_CATEGORY,
  assertNoUnsettledStakes,
  settleRoundStakes,
  toCompetitionResultRows,
  upsertCompetitionResults,
  upsertRoundOutcome,
} from "@/lib/server/services/evaluation/outcomes-persist";
import type { RoundResolution } from "@/lib/server/services/evaluation/outcome";

/**
 * F15 persistence tests.
 *
 * The database constraints (one outcome per round, void returns stakes,
 * finalized outcomes immutable) are covered by `supabase/tests/f15_outcomes.sql`.
 * These pin the app-side contract: which table, which conflict target, that a
 * void records no winner, and that settlement only ever touches unsettled rows.
 */

const logInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/logging/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: logInfo,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

/** A minimal fake that records upsert/update/select calls. */
function fakeClient() {
  const calls: Array<{ table: string; kind: string; payload: unknown }> = [];
  const client = {
    from(table: string) {
      return {
        upsert: (payload: unknown) => {
          calls.push({ table, kind: "upsert", payload });
          return Promise.resolve({ error: null });
        },
        update: (payload: unknown) => {
          calls.push({ table, kind: "update", payload });
          const chain = {
            eq: () => chain,
            is: () => chain,
            select: () =>
              Promise.resolve({ data: [{ id: "p-1" }], error: null }),
          };
          return chain;
        },
        select: () => {
          calls.push({ table, kind: "select", payload: null });
          const chain = {
            eq: () => chain,
            is: () => Promise.resolve({ count: 0, error: null }),
          };
          return chain;
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

beforeEach(() => {
  logInfo.mockReset();
});

const VOID_RESOLUTION: Extract<RoundResolution, { kind: "voided" }> = {
  kind: "voided",
  reason: "Every model forfeited, so the round is void.",
  results: [
    {
      modelId: "m-a",
      name: "A",
      ordinal: 1,
      status: "forfeited",
      reason: "The render threw.",
    },
    {
      modelId: "m-b",
      name: "B",
      ordinal: 2,
      status: "forfeited",
      reason: "The render timed out.",
    },
  ],
};

const SETTLED_RESOLUTION: Extract<RoundResolution, { kind: "settled" }> = {
  kind: "settled",
  winnerModelId: "m-a",
  fanFavoriteModelId: "m-b",
  tieBreak: "crowd-vote",
  reason: "Two models conformed; the crowd voted A best.",
  results: [
    {
      modelId: "m-a",
      name: "A",
      ordinal: 1,
      status: "conformed",
      reason: "Follows the brief.",
    },
    {
      modelId: "m-b",
      name: "B",
      ordinal: 2,
      status: "conformed",
      reason: "Follows the brief.",
    },
  ],
};

describe("toCompetitionResultRows", () => {
  it("maps every model to a conformance-category row", () => {
    const rows = toCompetitionResultRows(VOID_RESOLUTION);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "forfeited")).toBe(true);
  });
});

describe("upsertCompetitionResults", () => {
  it("upserts against (round, model, category) so a re-run does not duplicate", async () => {
    const { client, calls } = fakeClient();
    const written = await upsertCompetitionResults(
      { roundId: "r-1", resolution: SETTLED_RESOLUTION },
      client,
    );
    expect(written.written).toBe(2);

    const upsert = calls.find((c) => c.table === "competition_results");
    expect(upsert).toBeDefined();
    const rows = upsert?.payload as Array<Record<string, unknown>>;
    expect(rows[0].category).toBe(CONFORMANCE_CATEGORY);
    // Placement is deliberately null: conformance is not an ordered ranking.
    expect(rows[0].placement).toBeNull();
    expect(rows[0].round_id).toBe("r-1");
  });
});

describe("upsertRoundOutcome", () => {
  it("records a settled outcome with a winner and tiebreak", async () => {
    const { client, calls } = fakeClient();
    await upsertRoundOutcome(
      { roundId: "r-1", resolution: SETTLED_RESOLUTION },
      client,
    );

    const upsert = calls.find((c) => c.table === "round_outcomes");
    const row = upsert?.payload as Record<string, unknown>;
    expect(row.kind).toBe("settled");
    expect(row.winner_model_id).toBe("m-a");
    expect(row.fan_favorite_model_id).toBe("m-b");
    expect(row.tie_break).toBe("crowd-vote");

    expect(logInfo).toHaveBeenCalledWith(
      "round.outcome.recorded",
      expect.objectContaining({ roundId: "r-1", kind: "settled" }),
    );
  });

  it("records a void with no winner and the all-forfeited flag", async () => {
    const { client, calls } = fakeClient();
    await upsertRoundOutcome(
      { roundId: "r-2", resolution: VOID_RESOLUTION },
      client,
    );

    const row = calls.find((c) => c.table === "round_outcomes")
      ?.payload as Record<string, unknown>;
    expect(row.kind).toBe("voided");
    expect(row.winner_model_id).toBeNull();
    expect(row.tie_break).toBeNull();
    expect(row.all_forfeited).toBe(true);
  });
});

describe("settleRoundStakes", () => {
  it("only touches unsettled rows, so a retry cannot double-pay", async () => {
    const { client } = fakeClient();
    const result = await settleRoundStakes(
      {
        roundId: "r-1",
        settlements: [
          { predictionId: "p-1", outcome: "void", pointsAwarded: 0 },
        ],
      },
      client,
    );
    expect(result.settled).toBe(1);
  });

  it("returns a stake on a void with zero points, recorded as void", async () => {
    const updates: unknown[] = [];
    const client = {
      from() {
        return {
          update: (payload: unknown) => {
            updates.push(payload);
            const chain = {
              eq: () => chain,
              is: () => chain,
              select: () =>
                Promise.resolve({ data: [{ id: "p-1" }], error: null }),
            };
            return chain;
          },
          select: () => {
            const chain = {
              eq: () => chain,
              is: () => Promise.resolve({ count: 0, error: null }),
            };
            return chain;
          },
        };
      },
    } as unknown as SupabaseClient;

    await settleRoundStakes(
      {
        roundId: "r-1",
        settlements: [
          { predictionId: "p-1", outcome: "void", pointsAwarded: 0 },
        ],
      },
      client,
    );

    expect(updates[0]).toMatchObject({
      settlement_outcome: "void",
      points_awarded: 0,
    });
    expect((updates[0] as Record<string, unknown>).settled_at).toBeTruthy();
  });

  it("refuses a negative award", async () => {
    const { client } = fakeClient();
    await expect(
      settleRoundStakes(
        {
          roundId: "r-1",
          settlements: [
            { predictionId: "p-1", outcome: "lost", pointsAwarded: -5 },
          ],
        },
        client,
      ),
    ).rejects.toBeInstanceOf(InternalError);
  });
});

describe("assertNoUnsettledStakes", () => {
  it("passes when every conformance stake is settled", async () => {
    const { client } = fakeClient();
    await expect(
      assertNoUnsettledStakes("r-1", client),
    ).resolves.toBeUndefined();
  });

  it("throws a ConflictError while any conformance stake is open", async () => {
    const client = {
      from() {
        return {
          select: () => {
            const chain = {
              eq: () => chain,
              is: () => Promise.resolve({ count: 2, error: null }),
            };
            return chain;
          },
        };
      },
    } as unknown as SupabaseClient;

    await expect(assertNoUnsettledStakes("r-1", client)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});
