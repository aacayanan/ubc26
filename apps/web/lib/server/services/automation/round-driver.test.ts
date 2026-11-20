import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@/lib/server/errors/app-error";

/**
 * The round driver: the piece that makes a round advance without an operator.
 *
 * These tests pin the part the bug was about — that one pass locks due rounds,
 * settles finished ones, launches generation for the right rounds, and keeps
 * going when a stage fails. The stage implementations are mocked: their own
 * behaviour is covered by their own tests, and what matters here is the order
 * and the failure isolation.
 */

const calls: string[] = [];

const lockDueRounds = vi.fn(async () => {
  calls.push("lock");
  return { locked: [] as Array<{ roundId: string }>, hasMore: false };
});
const listRoundsForPipeline = vi.fn(async () => [] as unknown[]);
const listRoundsAwaitingSettlement = vi.fn(async () => [] as unknown[]);
const settleRound = vi.fn(async () => ({ status: "settled" }));
const processPayouts = vi.fn(async () => ({ confirmed: 0 }));
const reconcileSubmittedWagers = vi.fn(async () => ({ resolved: 0 }));

vi.mock("@/lib/server/services/competitions/lock", () => ({ lockDueRounds }));
vi.mock("@/lib/server/services/pipeline/run-round", () => ({
  listRoundsForPipeline,
  runRoundPipeline: vi.fn(),
}));
vi.mock("@/lib/server/services/scoring/settlement", () => ({
  listRoundsAwaitingSettlement,
  settleRound,
}));
vi.mock("@/lib/server/services/wagering/payouts", () => ({ processPayouts }));
vi.mock("@/lib/server/services/wagering/wagers", () => ({
  reconcileSubmittedWagers,
}));
vi.mock("@/lib/server/logging/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { driveRounds, isClaimConflict } =
  await import("@/lib/server/services/automation/round-driver");

const supabase = {} as never;

beforeEach(() => {
  calls.length = 0;
  lockDueRounds.mockClear();
  listRoundsForPipeline.mockClear();
  listRoundsAwaitingSettlement.mockClear();
  settleRound.mockClear();
  processPayouts.mockClear();
  reconcileSubmittedWagers.mockClear();
});

describe("driveRounds", () => {
  it("locks before it looks for work", async () => {
    await driveRounds({ correlationId: "c", supabase, runMoney: false });
    expect(calls).toEqual(["lock"]);
    expect(lockDueRounds).toHaveBeenCalledWith({
      correlationId: "c",
      supabase,
    });
  });

  it("settles every round in EVALUATING and reports what it decided", async () => {
    listRoundsAwaitingSettlement.mockResolvedValueOnce([
      { id: "r1", slug: "one" },
      { id: "r2", slug: "two" },
    ]);
    settleRound
      .mockResolvedValueOnce({ status: "settled" })
      .mockResolvedValueOnce({ status: "retryable" });

    const summary = await driveRounds({
      correlationId: "c",
      supabase,
      runMoney: false,
    });

    expect(settleRound).toHaveBeenCalledTimes(2);
    // Only a real decision counts as settled; a retryable round is left alone.
    expect(summary.settled).toBe(1);
    expect(summary.settledRounds).toEqual([
      { roundId: "r1", slug: "one", result: "settled" },
    ]);
  });

  it("never hands generation an EVALUATING round — those are settled, not re-generated", async () => {
    listRoundsForPipeline.mockResolvedValueOnce([
      { id: "a", slug: "a", status: "LOCKED" },
      { id: "b", slug: "b", status: "EVALUATING" },
      { id: "c", slug: "c", status: "RUNNING" },
    ]);

    const summary = await driveRounds({
      correlationId: "c",
      supabase,
      runMoney: false,
    });

    expect(summary.pending.map((round) => round.id)).toEqual(["a", "c"]);
  });

  it("keeps going when one stage throws, and reports the failure", async () => {
    lockDueRounds.mockRejectedValueOnce(new Error("db down"));
    listRoundsAwaitingSettlement.mockResolvedValueOnce([
      { id: "r1", slug: "one" },
    ]);

    const summary = await driveRounds({
      correlationId: "c",
      supabase,
      runMoney: false,
    });

    expect(summary.errors).toEqual([{ stage: "lock", message: "db down" }]);
    // The failure of the lock stage did not stop settlement.
    expect(settleRound).toHaveBeenCalledTimes(1);
  });

  it("does not treat 'wagers still confirming' as an error", async () => {
    listRoundsAwaitingSettlement.mockResolvedValueOnce([
      { id: "r1", slug: "one" },
    ]);
    settleRound.mockRejectedValueOnce(
      new ConflictError(
        "2 wager(s) are still confirming on Devnet; settlement will retry",
      ),
    );

    const summary = await driveRounds({
      correlationId: "c",
      supabase,
      runMoney: false,
    });

    expect(summary.errors).toEqual([]);
    expect(summary.settled).toBe(0);
  });

  it("only touches Devnet money when the money lane is due", async () => {
    await driveRounds({ correlationId: "c", supabase, runMoney: false });
    expect(processPayouts).not.toHaveBeenCalled();

    await driveRounds({ correlationId: "c", supabase, runMoney: true });
    expect(reconcileSubmittedWagers).toHaveBeenCalledTimes(1);
    expect(processPayouts).toHaveBeenCalledTimes(1);
  });
});

describe("isClaimConflict", () => {
  it("recognises a lost claim as a conflict, not a failure", () => {
    expect(
      isClaimConflict(
        new ConflictError("Round r1 was claimed by another runner; skipped."),
      ),
    ).toBe(true);
  });

  it("does not swallow an ordinary conflict", () => {
    expect(isClaimConflict(new ConflictError("No judge is seated"))).toBe(
      false,
    );
    expect(isClaimConflict(new Error("claimed"))).toBe(false);
  });
});
