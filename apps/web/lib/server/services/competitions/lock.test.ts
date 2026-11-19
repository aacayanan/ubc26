import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { InternalError, ValidationError } from "@/lib/server/errors/app-error";
import {
  assertLockLimit,
  listRoundsAwaitingRun,
  lockDueRounds,
  MAX_LOCK_BATCH,
} from "./lock";

/**
 * F11 unit tests.
 *
 * The transition semantics themselves are SQL (migration 20261118101400) and
 * are covered by the schema assertion script; these tests pin the app-side
 * contract — which RPC is called with what arguments, how a repeat maps to a
 * no-op, and how errors surface — so a refactor cannot quietly change any of it.
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

type RpcResult = { data: unknown; error: { message: string } | null };

function fakeClient(rpc: (fn: string, args: unknown) => RpcResult) {
  return {
    rpc: vi.fn(async (fn: string, args: unknown) => rpc(fn, args)),
  } as unknown as SupabaseClient & {
    rpc: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  logInfo.mockReset();
});

test("passes the batch limit and omits overrides it was not given", async () => {
  let received: Record<string, unknown> | undefined;
  const supabase = fakeClient((_fn, args) => {
    received = args as Record<string, unknown>;
    return { data: [], error: null };
  });

  await lockDueRounds({ correlationId: "c-1", supabase, limit: 10 });

  assert.deepEqual(received, { p_limit: 10 });
});

test("an ISO clock override is passed through, not evaluated locally", async () => {
  let received: Record<string, unknown> | undefined;
  const supabase = fakeClient((_fn, args) => {
    received = args as Record<string, unknown>;
    return { data: [], error: null };
  });

  const now = "2026-11-20T18:00:00.000Z";
  await lockDueRounds({ correlationId: "c-1", supabase, now });

  assert.equal(received?.p_now, now);
});

test("maps RPC rows to the public result and reports more work", async () => {
  const supabase = fakeClient(() => ({
    data: [
      { round_id: "r-1", previous_status: "OPEN", new_status: "LOCKED" },
      { round_id: "r-2", previous_status: "OPEN", new_status: "LOCKED" },
    ],
    error: null,
  }));

  const result = await lockDueRounds({
    correlationId: "c-1",
    supabase,
    limit: 2,
  });

  assert.deepEqual(result.locked, [
    { roundId: "r-1", previousStatus: "OPEN", newStatus: "LOCKED" },
    { roundId: "r-2", previousStatus: "OPEN", newStatus: "LOCKED" },
  ]);
  // A full batch means there may be more due rounds.
  assert.equal(result.hasMore, true);
});

test("a partial batch does not report more work", async () => {
  const supabase = fakeClient(() => ({
    data: [{ round_id: "r-1", previous_status: "OPEN", new_status: "LOCKED" }],
    error: null,
  }));

  const result = await lockDueRounds({
    correlationId: "c-1",
    supabase,
    limit: 10,
  });

  assert.equal(result.hasMore, false);
});

test("re-running with nothing due is a clean empty result", async () => {
  const supabase = fakeClient(() => ({ data: [], error: null }));

  const result = await lockDueRounds({ correlationId: "c-1", supabase });

  assert.deepEqual(result, { locked: [], hasMore: false });
  // Nothing locked means no noisy log line on every tick.
  assert.equal(logInfo.mock.calls.length, 0);
});

test("logs one batched line when rounds are locked", async () => {
  const supabase = fakeClient(() => ({
    data: [{ round_id: "r-1", previous_status: "OPEN", new_status: "LOCKED" }],
    error: null,
  }));

  await lockDueRounds({ correlationId: "c-1", supabase });

  assert.equal(logInfo.mock.calls.length, 1);
  assert.equal(logInfo.mock.calls[0]?.[0], "rounds.locked");
  assert.deepEqual(logInfo.mock.calls[0]?.[1], {
    correlationId: "c-1",
    count: 1,
    roundIds: ["r-1"],
  });
});

test("an RPC failure becomes an InternalError carrying the cause", async () => {
  const supabase = fakeClient(() => ({
    data: null,
    error: { message: "boom" },
  }));

  await assert.rejects(
    () => lockDueRounds({ correlationId: "c-1", supabase }),
    (error) => error instanceof InternalError,
  );
});

test("rejects a malformed clock before touching the database", async () => {
  const supabase = fakeClient(() => ({ data: [], error: null }));

  await assert.rejects(
    () => lockDueRounds({ correlationId: "c-1", supabase, now: "not-a-date" }),
    (error) => error instanceof ValidationError,
  );
  assert.equal(supabase.rpc.mock.calls.length, 0);
});

test("rejects an out-of-range limit at the boundary", () => {
  assert.throws(() => assertLockLimit(0), ValidationError);
  assert.throws(() => assertLockLimit(MAX_LOCK_BATCH + 1), ValidationError);
  assert.throws(() => assertLockLimit(1.5), ValidationError);
  assert.doesNotThrow(() => assertLockLimit(1));
  assert.doesNotThrow(() => assertLockLimit(MAX_LOCK_BATCH));
});

test("lists LOCKED rounds for the next stage, oldest first", async () => {
  const calls: Array<[string, unknown[]]> = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      calls.push(["eq", [column, value]]);
      return builder;
    }),
    order: vi.fn((column: string, options: unknown) => {
      calls.push(["order", [column, options]]);
      return builder;
    }),
    limit: vi.fn((value: unknown) => {
      calls.push(["limit", [value]]);
      return Promise.resolve({
        data: [
          {
            id: "r-1",
            slug: "round-one",
            status: "LOCKED",
            prediction_deadline: "2026-11-20T18:00:00.000Z",
            locked_at: "2026-11-20T18:00:01.000Z",
          },
        ],
        error: null,
      });
    }),
  };
  const supabase = { from: vi.fn(() => builder) } as unknown as SupabaseClient;

  const rounds = await listRoundsAwaitingRun({ supabase, limit: 7 });

  assert.deepEqual(rounds, [
    {
      id: "r-1",
      slug: "round-one",
      status: "LOCKED",
      predictionDeadline: "2026-11-20T18:00:00.000Z",
      lockedAt: "2026-11-20T18:00:01.000Z",
    },
  ]);
  assert.deepEqual(
    calls.filter(([kind]) => kind === "eq"),
    [["eq", ["status", "LOCKED"]]],
  );
  assert.deepEqual(
    calls.filter(([kind]) => kind === "limit").map(([, args]) => args),
    [[7]],
  );
});
