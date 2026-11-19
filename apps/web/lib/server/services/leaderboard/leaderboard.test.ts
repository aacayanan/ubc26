import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  LEADERBOARD_LIMIT,
  aggregateSettled,
  getLeaderboard,
  opaqueKey,
  pseudonymFor,
  rankEntries,
  sanitizeDisplayName,
} from "./leaderboard";

// Isolated test fixtures. Never rendered anywhere; ids are synthetic.
const U = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("sanitizeDisplayName", () => {
  it("keeps an ordinary chosen name", () => {
    expect(sanitizeDisplayName("  Ada   Lovelace ")).toBe("Ada Lovelace");
  });

  it("refuses email-like names (F8 falls back to the account email)", () => {
    expect(sanitizeDisplayName("someone@example.com")).toBeNull();
    expect(sanitizeDisplayName("Call me a@b.co")).toBeNull();
  });

  it("refuses Solana-address-like names", () => {
    expect(
      sanitizeDisplayName("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV"),
    ).toBeNull();
  });

  it("treats empty, whitespace and control-only names as missing", () => {
    expect(sanitizeDisplayName(null)).toBeNull();
    expect(sanitizeDisplayName("   ")).toBeNull();
    expect(sanitizeDisplayName("‮\u0000")).toBeNull();
  });

  it("truncates very long names", () => {
    const name = sanitizeDisplayName("x".repeat(80))!;
    expect(name.length).toBe(32);
    expect(name.endsWith("…")).toBe(true);
  });
});

describe("pseudonyms and keys", () => {
  it("are stable and never contain the user id", () => {
    expect(pseudonymFor(U(1))).toBe(pseudonymFor(U(1)));
    expect(pseudonymFor(U(1))).not.toBe(pseudonymFor(U(2)));
    expect(pseudonymFor(U(1))).toMatch(/^Player [0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(opaqueKey(U(1))).not.toContain("0000");
  });
});

describe("aggregateSettled", () => {
  it("sums per user and counts distinct settled rounds", () => {
    const totals = aggregateSettled([
      { userId: U(1), roundId: "r1", points: 10 },
      { userId: U(1), roundId: "r2", points: 5 },
      { userId: U(2), roundId: "r1", points: 0 },
    ]);
    expect(totals.get(U(1))).toMatchObject({ points: 15 });
    expect(totals.get(U(1))!.rounds.size).toBe(2);
    expect(totals.get(U(2))).toMatchObject({ points: 0 });
  });

  it("sums every event kind in a round but counts the round once", () => {
    // A user who staked AND voted for the fan-favorite has two events (F18);
    // both count toward points, the round counts once.
    const totals = aggregateSettled([
      { userId: U(1), roundId: "r1", points: 10 },
      { userId: U(1), roundId: "r1", points: 25 },
      { userId: U(1), roundId: "r2", points: 5 },
      { userId: U(2), roundId: "r1", points: 0 },
    ]);
    expect(totals.get(U(1))).toMatchObject({ points: 40 });
    expect(totals.get(U(1))!.rounds.size).toBe(2);
    expect(totals.get(U(2))).toMatchObject({ points: 0 });
  });

  it("drops malformed points instead of guessing", () => {
    const totals = aggregateSettled([
      { userId: U(1), roundId: "r1", points: 10 },
      { userId: U(1), roundId: "r2", points: -4 },
      { userId: U(1), roundId: "r3", points: 1.5 },
    ]);
    expect(totals.get(U(1))!.points).toBe(10);
  });
});

describe("rankEntries", () => {
  const row = (n: number, points: number, name: string | null = `n${n}`) => ({
    userId: U(n),
    displayName: name,
    points,
    settledRounds: 1,
    streak: null,
  });

  it("uses competition ranking: ties share a rank, next rank skips", () => {
    const ranked = rankEntries(
      [row(1, 10), row(2, 30), row(3, 30), row(4, 5)],
      null,
    );
    expect(ranked.map((e) => [e.points, e.rank, e.tied])).toEqual([
      [30, 1, true],
      [30, 1, true],
      [10, 3, false],
      [5, 4, false],
    ]);
  });

  it("orders ties deterministically regardless of input order", () => {
    const a = rankEntries([row(2, 30), row(3, 30), row(9, 30)], null);
    const b = rankEntries([row(9, 30), row(3, 30), row(2, 30)], null);
    expect(a.map((e) => e.key)).toEqual(b.map((e) => e.key));
    const keys = a.map((e) => e.key);
    expect(keys).toEqual([...keys].sort());
  });

  it("substitutes a pseudonym for missing or unsafe names", () => {
    const [entry] = rankEntries([row(1, 1, "me@example.com")], null);
    expect(entry.displayName).toBe(pseudonymFor(U(1)));
    expect(entry.pseudonymous).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("example.com");
    expect(JSON.stringify(entry)).not.toContain(U(1));
  });

  it("flags only the viewer", () => {
    const ranked = rankEntries([row(1, 1), row(2, 2)], U(1));
    expect(ranked.filter((e) => e.isViewer)).toHaveLength(1);
    expect(ranked.find((e) => e.isViewer)!.points).toBe(1);
  });
});

/** Minimal PostgREST query-builder stub: records filters, returns rows. */
function stubClient(tables: Record<string, unknown[]>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "in", "gt", "order"]) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return builder;
        };
      }
      builder.range = (from: number, to: number) => {
        calls.push({ table, method: "range", args: [from, to] });
        return Promise.resolve({
          data: (tables[table] ?? []).slice(from, to + 1),
          error: null,
        });
      };
      builder.then = (resolve: (v: unknown) => void) =>
        resolve({ data: tables[table] ?? [], error: null });
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("getLeaderboard", () => {
  const score = (n: number, points: number, streak = 0) => ({
    user_id: U(n),
    total_points: points,
    current_streak: streak,
  });

  it("ranks by the user_scores balance and counts settled rounds", async () => {
    const { client, calls } = stubClient({
      user_scores: [score(1, 5, 4), score(2, 3), score(3, 3)],
      score_events: [
        { user_id: U(1), round_id: "r1", points: 5 },
        { user_id: U(1), round_id: "r2", points: 0 },
      ],
      users: [
        { id: U(1), display_name: "Ada" },
        { id: U(2), display_name: "bo@example.com" },
        { id: U(3), display_name: "Cy" },
      ],
    });

    const board = await getLeaderboard(client, U(2));

    expect(calls).toContainEqual({
      table: "user_scores",
      method: "gt",
      args: ["total_points", 0],
    });
    expect(calls).toContainEqual({
      table: "score_events",
      method: "in",
      args: ["rounds.status", ["SETTLED", "ARCHIVED"]],
    });
    expect(board.entries.map((e) => [e.points, e.rank, e.tied])).toEqual([
      [5, 1, false],
      [3, 2, true],
      [3, 2, true],
    ]);
    expect(board.entries[0]).toMatchObject({
      displayName: "Ada",
      settledRounds: 2,
      // F18 defines the streak rule and settlement writes the column.
      streak: 4,
    });
    expect(board.pending).toEqual({ streaks: false, hitRate: true });
    expect(JSON.stringify(board)).not.toContain("example.com");
    expect(board.entries.find((e) => e.isViewer)!.pseudonymous).toBe(true);
  });

  it("skips zero and malformed balances", async () => {
    const { client } = stubClient({
      user_scores: [score(1, 0), score(2, 2.5), score(3, 7)],
      users: [],
    });
    const board = await getLeaderboard(client, null);
    expect(board.entries.map((e) => e.points)).toEqual([7]);
  });

  it("returns an empty board when no account has points", async () => {
    const { client, calls } = stubClient({ user_scores: [] });
    await expect(getLeaderboard(client, null)).resolves.toEqual({
      entries: [],
      totalRanked: 0,
      pending: { streaks: false, hitRate: true },
    });
    expect(calls.some((c) => c.table === "users")).toBe(false);
  });

  it("ranks an account with a missing profile row under a pseudonym", async () => {
    const { client } = stubClient({ user_scores: [score(7, 3)], users: [] });
    const board = await getLeaderboard(client, null);
    expect(board.entries[0]).toMatchObject({
      displayName: pseudonymFor(U(7)),
      settledRounds: 0,
    });
  });

  it("keeps the viewer visible when they rank outside the top list", async () => {
    const rows = Array.from({ length: LEADERBOARD_LIMIT + 5 }, (_, i) =>
      score(i + 1, 1000 - i),
    );
    const viewer = U(LEADERBOARD_LIMIT + 5);
    const { client } = stubClient({ user_scores: rows, users: [] });
    const board = await getLeaderboard(client, viewer);
    expect(board.totalRanked).toBe(LEADERBOARD_LIMIT + 5);
    expect(board.entries).toHaveLength(LEADERBOARD_LIMIT + 1);
    expect(board.entries.at(-1)).toMatchObject({
      isViewer: true,
      rank: LEADERBOARD_LIMIT + 5,
    });
  });

  it("surfaces query failures as an InternalError", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.in = () => b;
        b.gt = () => b;
        b.order = () => b;
        b.range = () =>
          Promise.resolve({ data: null, error: { message: "boom" } });
        return b;
      },
    } as unknown as SupabaseClient;
    await expect(getLeaderboard(client, null)).rejects.toThrow(
      "Failed to load points balances",
    );
  });
});
