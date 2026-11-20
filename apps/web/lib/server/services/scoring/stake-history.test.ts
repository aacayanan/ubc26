import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listUserStakes, type StakeRecord } from "./stake-history";

/**
 * Prediction history (F26).
 *
 * The bug these guard against is not in the mapping — it is in the *query*. The
 * history read used to embed `llm_models(name)` directly off `predictions`, but
 * `predictions` has no FK to `llm_models`: its only model reference is the
 * composite FK to `round_models(round_id, model_id)`. PostgREST follows declared
 * FKs only, so that join was not a relationship and the whole request failed —
 * surfacing to the user as a generic "unexpected error", not as a missing name.
 *
 * So the first thing pinned here is that the select text embeds the model
 * *through* `round_models`, which is the path that actually exists. The rest
 * pins the state/outcome split, which is what the page keys its copy on.
 */

const ROUND_ID = "22222222-2222-4222-8222-222222222222";
const PICKED_MODEL = "33333333-3333-4333-8333-333333333333";

interface FakeRow {
  rounds: unknown;
}

/** A client whose `.select()` records its argument, then returns fixed rows. */
function fakeSupabase(rows: FakeRow[]) {
  const selects: string[] = [];

  const client = {
    from(table: string) {
      if (table !== "wagers") {
        throw new Error(`unexpected table read: ${table}`);
      }
      const chain = {
        select(columns: string) {
          selects.push(columns);
          return chain;
        },
        eq() {
          return chain;
        },
        order() {
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return chain;
    },
  };

  return { client: client as unknown as SupabaseClient, selects };
}

/** One prediction row, shaped as PostgREST returns the nested selects. */
function row(overrides: {
  settlement_outcome?: "won" | "lost" | "refunded" | null;
  payout_lamports?: number | null;
  roundStatus?: string;
  roundModels?: unknown[];
}): FakeRow {
  return {
    rounds: {
      status: overrides.roundStatus ?? "OPEN",
      challenges: { title: "Isometric donut" },
      round_models: overrides.roundModels ?? [
        {
          model_id: PICKED_MODEL,
          llm_models: { name: "GPT-4o mini" },
        },
      ],
    },
    // The mapper reads these off the row; the fake carries them too.
    ...{
      id: "stake-1",
      round_id: ROUND_ID,
      model_id: PICKED_MODEL,
      lamports: 250_000_000,
      payout_lamports: overrides.payout_lamports ?? null,
      settlement_outcome: overrides.settlement_outcome ?? null,
      created_at: "2026-11-20T00:00:00Z",
    },
  };
}

async function stakeFor(overrides: Parameters<typeof row>[0] = {}) {
  const { client } = fakeSupabase([row(overrides)]);
  const stakes = await listUserStakes("user-1", client);
  return stakes[0];
}

/** Split a PostgREST select string on the commas that are not inside parens. */
function topLevelSegments(select: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of select) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

describe("listUserStakes", () => {
  it("embeds the model through round_models, not directly off predictions", async () => {
    const { client, selects } = fakeSupabase([row({})]);
    await listUserStakes("user-1", client);

    expect(selects).toHaveLength(1);
    const select = selects[0];

    // The relationship that exists.
    expect(select).toContain("round_models");
    expect(select).toContain("llm_models(name)");

    // The one that does not: `llm_models` must never appear as a *top-level*
    // sibling of `rounds`, which would mean the embed had been moved back off
    // `predictions`. Split on top-level commas so the nested occurrence inside
    // `round_models(...)` does not count.
    const topLevel = topLevelSegments(select);
    expect(topLevel.some((segment) => segment.startsWith("llm_models("))).toBe(
      false,
    );
  });

  it("resolves the picked model's name from the roster entry it names", async () => {
    const stake = await stakeFor({
      roundModels: [
        { model_id: "other-model", llm_models: { name: "Gemini 2.5 Flash" } },
        { model_id: PICKED_MODEL, llm_models: { name: "GPT-4o mini" } },
      ],
    });

    expect(stake.pickedModel).toBe("GPT-4o mini");
  });

  it("still resolves a name when PostgREST returns the embed as an array", async () => {
    const stake = await stakeFor({
      roundModels: [
        { model_id: PICKED_MODEL, llm_models: [{ name: "GPT-4o mini" }] },
      ],
    });

    expect(stake.pickedModel).toBe("GPT-4o mini");
  });

  describe("state", () => {
    it("is `open` and shows no payout for an OPEN round", async () => {
      const stake = await stakeFor({ roundStatus: "OPEN" });

      expect(stake.state).toBe("open");
      expect(stake.outcome).toBeNull();
      expect(stake.payoutSol).toBeNull();
    });

    it("is `locked` before anything rendered", async () => {
      expect((await stakeFor({ roundStatus: "LOCKED" }))?.state).toBe("locked");
    });

    it.each(["RUNNING", "EVALUATING", "RETRYING"])(
      "is `running` while the round is %s",
      async (roundStatus) => {
        expect((await stakeFor({ roundStatus }))?.state).toBe("running");
      },
    );

    it("is `settling` when the round is settled but no payout was written", async () => {
      const stake = await stakeFor({ roundStatus: "SETTLED" });

      expect(stake.state).toBe("settling");
      expect(stake.payoutSol).toBeNull();
    });
  });

  describe("outcome", () => {
    it.each([
      ["won", "won", 480_000_000, 0.48],
      ["lost", "lost", 0, 0],
      ["refunded", "void", 250_000_000, 0.25],
    ] as const)(
      "follows settlement_outcome = %s",
      async (settled, outcome, lamports, sol) => {
        const stake = await stakeFor({
          roundStatus: "SETTLED",
          settlement_outcome: settled,
          payout_lamports: lamports,
        });

        expect(stake.state).toBe(outcome);
        expect(stake.outcome).toBe(outcome);
        expect(stake.payoutSol).toBe(sol);
        expect(stake.amountSol).toBe(0.25);
      },
    );

    it.each(["VOIDED", "FAILED", "CANCELLED"])(
      "is `void` when the round ended %s with no settlement row",
      async (roundStatus) => {
        const stake = await stakeFor({ roundStatus });

        expect(stake.state).toBe("void");
        // No payout was recorded, so the record must not invent one.
        expect(stake.payoutSol).toBeNull();
      },
    );
  });

  describe("resultHref", () => {
    it("is null for an OPEN round — a result page would show nothing yet", async () => {
      expect((await stakeFor({ roundStatus: "OPEN" }))?.resultHref).toBeNull();
    });

    it.each([
      "LOCKED",
      "RUNNING",
      "EVALUATING",
      "SETTLED",
      "VOIDED",
      "ARCHIVED",
      "FAILED",
      "CANCELLED",
    ])(
      "links to the results page once the round is %s",
      async (roundStatus) => {
        const stake = await stakeFor({ roundStatus });

        expect(stake.resultHref).toBe(`/results/${ROUND_ID}`);
      },
    );
  });

  it("falls back to neutral copy rather than throwing on a missing embed", async () => {
    const stake: StakeRecord | undefined = await stakeFor({
      roundModels: [],
    });

    expect(stake?.pickedModel).toBe("Model");
    expect(stake?.briefTitle).toBe("Isometric donut");
  });
});
