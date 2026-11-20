import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/integrations/supabase/admin", () => ({
  getServiceRoleSupabase: vi.fn(),
}));
vi.mock("@/lib/server/integrations/solana/connection", () => ({
  getDevnetConnection: vi.fn(),
}));

import { commitmentHash, wagerMemo } from "./commitment";
import {
  LANDING_GRACE_SECONDS,
  evaluateCommitment,
  type LandedCommitment,
  type StoredWager,
  type WagerWindow,
} from "./verify";

// Synthetic fixtures; never rendered anywhere.
const ROUND = "11111111-1111-4111-8111-111111111111";
const WAGER = "22222222-2222-4222-8222-222222222222";
const MODEL = "33333333-3333-4333-8333-333333333333";
const WALLET = "4HdvMNEzq2DA6JiMjMxoc78FLB6LSe9zF4mx1VakWZVq";
const NONCE = "a".repeat(32);
const LAMPORTS = BigInt(50_000_000);
const HASH = commitmentHash({
  roundId: ROUND,
  wagerId: WAGER,
  modelId: MODEL,
  lamports: LAMPORTS,
  nonce: NONCE,
});

const wager = (overrides: Partial<StoredWager> = {}): StoredWager => ({
  id: WAGER,
  roundId: ROUND,
  modelId: MODEL,
  kind: "ante",
  lamports: LAMPORTS,
  walletAddress: WALLET,
  commitmentHash: HASH,
  nonce: NONCE,
  ...overrides,
});

const DEADLINE = "2026-11-20T12:00:00.000Z";
const window: WagerWindow = { anteDeadline: DEADLINE, bettingClosedAt: null };

const landed = (
  overrides: Partial<LandedCommitment> = {},
): LandedCommitment => ({
  found: true,
  failed: false,
  error: null,
  memos: [wagerMemo(ROUND, WAGER, HASH)],
  signers: ["OperatorFeePayer1111111111111111111111111111", WALLET],
  treasuryDelta: LAMPORTS,
  blockTime: "2026-11-20T11:59:30.000Z",
  slot: 42,
  ...overrides,
});

const byId = (checks: ReturnType<typeof evaluateCommitment>) =>
  Object.fromEntries(checks.map((check) => [check.id, check.ok]));

describe("evaluateCommitment", () => {
  it("passes every check for an honest, on-time wager", () => {
    const checks = evaluateCommitment(wager(), window, landed());
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks.map((check) => check.id)).toEqual([
      "on_chain",
      "signer",
      "memo",
      "hash_only",
      "transfer",
      "on_time",
      "preimage",
    ]);
  });

  it("fails when the signature is not on Devnet", () => {
    const result = byId(
      evaluateCommitment(
        wager(),
        window,
        landed({ found: false, memos: [], signers: [], blockTime: null }),
      ),
    );
    expect(result.on_chain).toBe(false);
    expect(result.memo).toBe(false);
  });

  it("fails when the transaction errored on-chain", () => {
    const result = byId(
      evaluateCommitment(wager(), window, landed({ failed: true, error: "x" })),
    );
    expect(result.on_chain).toBe(false);
  });

  it("fails when the account's wallet did not sign", () => {
    const result = byId(
      evaluateCommitment(
        wager(),
        window,
        landed({ signers: ["someone-else"] }),
      ),
    );
    expect(result.signer).toBe(false);
  });

  it("fails when the memo names a different hash", () => {
    const result = byId(
      evaluateCommitment(
        wager(),
        window,
        landed({ memos: [wagerMemo(ROUND, WAGER, "f".repeat(64))] }),
      ),
    );
    expect(result.memo).toBe(false);
  });

  it("flags a memo that leaks the pick or the nonce", () => {
    const result = byId(
      evaluateCommitment(
        wager(),
        window,
        landed({ memos: [`${wagerMemo(ROUND, WAGER, HASH)}:${MODEL}`] }),
      ),
    );
    expect(result.hash_only).toBe(false);
  });

  it("fails when the treasury did not receive the wagered amount", () => {
    const result = byId(
      evaluateCommitment(wager(), window, landed({ treasuryDelta: BigInt(1) })),
    );
    expect(result.transfer).toBe(false);
  });

  it("fails when a stored preimage was altered after the fact", () => {
    // A different pick under the same stored hash: the recomputation exposes it.
    const result = byId(
      evaluateCommitment(
        wager({ modelId: "44444444-4444-4444-8444-444444444444" }),
        window,
        landed(),
      ),
    );
    expect(result.preimage).toBe(false);
  });

  describe("timing", () => {
    const at = (offsetSeconds: number) =>
      new Date(Date.parse(DEADLINE) + offsetSeconds * 1000).toISOString();

    it("accepts an ante landing inside the landing window", () => {
      const result = byId(
        evaluateCommitment(
          wager(),
          window,
          landed({ blockTime: at(LANDING_GRACE_SECONDS) }),
        ),
      );
      expect(result.on_time).toBe(true);
    });

    it("rejects an ante landing after the deadline plus the window", () => {
      const result = byId(
        evaluateCommitment(
          wager(),
          window,
          landed({ blockTime: at(LANDING_GRACE_SECONDS + 1) }),
        ),
      );
      expect(result.on_time).toBe(false);
    });

    it("measures a live wager against the betting close, not the ante deadline", () => {
      const closed: WagerWindow = {
        anteDeadline: DEADLINE,
        bettingClosedAt: at(600),
      };
      const live = wager({ kind: "live" });
      expect(
        byId(evaluateCommitment(live, closed, landed({ blockTime: at(500) })))
          .on_time,
      ).toBe(true);
      expect(
        byId(
          evaluateCommitment(
            live,
            closed,
            landed({ blockTime: at(600 + LANDING_GRACE_SECONDS + 1) }),
          ),
        ).on_time,
      ).toBe(false);
    });

    it("treats a live wager as on time while betting is still open", () => {
      const result = byId(
        evaluateCommitment(
          wager({ kind: "live" }),
          window,
          landed({ blockTime: at(900) }),
        ),
      );
      expect(result.on_time).toBe(true);
    });

    it("fails when the network assigned no block time", () => {
      const result = byId(
        evaluateCommitment(wager(), window, landed({ blockTime: null })),
      );
      expect(result.on_time).toBe(false);
    });
  });
});
