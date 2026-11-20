import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  LEADERBOARD_LIMIT,
  aggregatePredictions,
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

describe("aggregatePredictions", () => {
  it("counts correct and decided predictions per user", () => {
    const totals = aggregatePredictions([
      { userId: U(1), correct: true },
      { userId: U(1), correct: false },
      { userId: U(1), correct: true },
      { userId: U(2), correct: false },
    ]);
    expect(totals.get(U(1))).toEqual({ correct: 2, decided: 3 });
    expect(totals.get(U(2))).toEqual({ correct: 0, decided: 1 });
  });
});

describe("rankEntries", () => {
  const row = (
    n: number,
    correct: number,
    name: string | null = `n${n}`,
    decided = correct + 1,
  ) => ({ userId: U(n), displayName: name, correct, decided });

  it("uses competition ranking on correct predictions", () => {
    const ranked = rankEntries(
      [row(1, 10), row(2, 30), row(3, 30, "n3", 50), row(4, 5)],
      null,
    );
    expect(ranked.map((e) => [e.correctPredictions, e.rank, e.tied])).toEqual([
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
    expect(ranked.find((e) => e.isViewer)!.correctPredictions).toBe(1);
  });
});

/** Minimal PostgREST query-builder stub: records filters, returns rows. */
function stubClient(tables: Record<string, unknown[]>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "in", "eq", "order"]) {
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
  const wager = (n: number, outcome: "won" | "lost") => ({
    user_id: U(n),
    settlement_outcome: outcome,
  });

  it("ranks by correct (won) settled wagers", async () => {
    const { client, calls } = stubClient({
      wagers: [
        wager(1, "won"),
        wager(1, "won"),
        wager(1, "lost"),
        wager(2, "won"),
        wager(3, "won"),
        wager(3, "lost"),
      ],
      users: [
        { id: U(1), display_name: "Ada" },
        { id: U(2), display_name: "bo@example.com" },
        { id: U(3), display_name: "Cy" },
      ],
    });

    const board = await getLeaderboard(client, U(2));

    expect(calls).toContainEqual({
      table: "wagers",
      method: "eq",
      args: ["status", "accepted"],
    });
    expect(calls).toContainEqual({
      table: "wagers",
      method: "in",
      args: ["settlement_outcome", ["won", "lost"]],
    });
    expect(
      board.entries.map((e) => [e.correctPredictions, e.rank, e.tied]),
    ).toEqual([
      [2, 1, false],
      [1, 2, true],
      [1, 2, true],
    ]);
    expect(board.entries[0]).toMatchObject({
      displayName: "Ada",
      decidedPredictions: 3,
    });
    expect(JSON.stringify(board)).not.toContain("example.com");
    expect(board.entries.find((e) => e.isViewer)!.pseudonymous).toBe(true);
  });

  it("returns an empty board when nothing has settled", async () => {
    const { client, calls } = stubClient({ wagers: [] });
    await expect(getLeaderboard(client, null)).resolves.toEqual({
      entries: [],
      totalRanked: 0,
    });
    expect(calls.some((c) => c.table === "users")).toBe(false);
  });

  it("ranks an account with a missing profile row under a pseudonym", async () => {
    const { client } = stubClient({ wagers: [wager(7, "won")], users: [] });
    const board = await getLeaderboard(client, null);
    expect(board.entries[0]).toMatchObject({
      displayName: pseudonymFor(U(7)),
      correctPredictions: 1,
    });
  });

  it("keeps the viewer visible when they rank outside the top list", async () => {
    const total = LEADERBOARD_LIMIT + 5;
    // User i+1 gets (total - i) correct predictions, so the last ranks last.
    const rows = Array.from({ length: total }, (_, i) =>
      Array.from({ length: total - i }, () => wager(i + 1, "won")),
    ).flat();
    const viewer = U(total);
    const { client } = stubClient({ wagers: rows, users: [] });
    const board = await getLeaderboard(client, viewer);
    expect(board.totalRanked).toBe(total);
    expect(board.entries).toHaveLength(LEADERBOARD_LIMIT + 1);
    expect(board.entries.at(-1)).toMatchObject({
      isViewer: true,
      rank: total,
    });
  });

  it("surfaces query failures as an InternalError", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.in = () => b;
        b.eq = () => b;
        b.order = () => b;
        b.range = () =>
          Promise.resolve({ data: null, error: { message: "boom" } });
        return b;
      },
    } as unknown as SupabaseClient;
    await expect(getLeaderboard(client, null)).rejects.toThrow(
      "Failed to load settled predictions",
    );
  });
});
