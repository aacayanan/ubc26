import { describe, expect, it } from "vitest";
import {
  LAMPORTS_PER_SOL,
  computeFee,
  estimatePool,
  formatSol,
  parseSolToLamports,
  settleSolPool,
  type SolWager,
} from "./sol-pool";

const MODELS = ["m-a", "m-b", "m-c"];

function wager(
  wagerId: string,
  userId: string,
  modelId: string,
  lamports: bigint,
): SolWager {
  return {
    wagerId,
    userId,
    walletAddress: `wallet-${userId}`,
    modelId,
    lamports,
  };
}

/** mulberry32: a tiny seeded PRNG so failures reproduce. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const sum = (values: bigint[]) => values.reduce((s, v) => s + v, BigInt(0));

describe("computeFee", () => {
  it("floors gross × bps / 10 000", () => {
    expect(computeFee(BigInt(1_000), 500)).toBe(BigInt(50));
    expect(computeFee(BigInt(1_999), 500)).toBe(BigInt(99)); // 99.95 floored
    expect(computeFee(BigInt(0), 500)).toBe(BigInt(0));
    expect(computeFee(BigInt(123), 0)).toBe(BigInt(0));
  });

  it("rejects out-of-range or fractional fees", () => {
    expect(() => computeFee(BigInt(1), -1)).toThrow();
    expect(() => computeFee(BigInt(1), 2001)).toThrow();
    expect(() => computeFee(BigInt(1), 2.5)).toThrow();
  });
});

describe("estimatePool", () => {
  it("reports net/staked multipliers and null for an unbacked model", () => {
    const estimate = estimatePool({
      modelIds: MODELS,
      wagers: [
        { modelId: "m-a", lamports: BigInt(3_000) },
        { modelId: "m-b", lamports: BigInt(1_000) },
      ],
      feeBps: 500,
    });
    expect(estimate.gross).toBe(BigInt(4_000));
    expect(estimate.fee).toBe(BigInt(200));
    expect(estimate.net).toBe(BigInt(3_800));
    expect(estimate.models.map((m) => m.multiplier)).toEqual([1.26, 3.8, null]);
    expect(estimate.models[0].share).toBeCloseTo(0.75);
    expect(estimate.models[2].share).toBe(0);
  });

  it("counts wagers on a model outside the list toward the pool", () => {
    const estimate = estimatePool({
      modelIds: ["m-a"],
      wagers: [
        { modelId: "m-a", lamports: BigInt(1_000) },
        { modelId: "m-gone", lamports: BigInt(1_000) },
      ],
      feeBps: 0,
    });
    expect(estimate.gross).toBe(BigInt(2_000));
    expect(estimate.models[0].multiplier).toBe(2);
  });

  it("handles an empty pool", () => {
    const estimate = estimatePool({
      modelIds: MODELS,
      wagers: [],
      feeBps: 500,
    });
    expect(estimate.gross).toBe(BigInt(0));
    expect(estimate.models.every((m) => m.multiplier === null)).toBe(true);
  });
});

describe("settleSolPool", () => {
  it("pays a single winner pro-rata after the fee", () => {
    const result = settleSolPool({
      wagers: [
        wager("w1", "u1", "m-a", BigInt(1_000)),
        wager("w2", "u2", "m-a", BigInt(3_000)),
        wager("w3", "u3", "m-b", BigInt(6_000)),
      ],
      winnerModelIds: ["m-a"],
      modelOrder: MODELS,
      feeBps: 500,
    });
    expect(result.kind).toBe("settled");
    expect(result.reason).toBe("settled");
    expect(result.fee).toBe(BigInt(500));
    expect(result.net).toBe(BigInt(9_500));
    expect(result.payouts).toEqual([
      {
        userId: "u1",
        walletAddress: "wallet-u1",
        kind: "winnings",
        lamports: BigInt(2_375),
        wagerIds: ["w1"],
      },
      {
        userId: "u2",
        walletAddress: "wallet-u2",
        kind: "winnings",
        lamports: BigInt(7_125),
        wagerIds: ["w2"],
      },
    ]);
    expect(result.wagerOutcomes.find((o) => o.wagerId === "w3")).toEqual({
      wagerId: "w3",
      outcome: "lost",
      lamports: BigInt(0),
    });
  });

  it("aggregates several winning wagers into one payout per user", () => {
    const result = settleSolPool({
      wagers: [
        wager("w1", "u1", "m-a", BigInt(1_000)),
        wager("w2", "u1", "m-a", BigInt(1_000)),
        wager("w3", "u1", "m-b", BigInt(1_000)),
        wager("w4", "u2", "m-b", BigInt(1_000)),
      ],
      winnerModelIds: ["m-a"],
      modelOrder: MODELS,
      feeBps: 0,
    });
    expect(result.payouts).toHaveLength(1);
    expect(result.payouts[0]).toMatchObject({
      userId: "u1",
      lamports: BigInt(4_000),
      wagerIds: ["w1", "w2"],
    });
  });

  it("splits a dead heat equally per model, then pro-rata", () => {
    const result = settleSolPool({
      wagers: [
        wager("w1", "u1", "m-a", BigInt(1_000)),
        wager("w2", "u2", "m-b", BigInt(9_000)),
        wager("w3", "u3", "m-c", BigInt(1)),
      ],
      winnerModelIds: ["m-b", "m-a"],
      modelOrder: MODELS,
      feeBps: 0,
    });
    expect(result.reason).toBe("dead_heat");
    expect(result.winners).toEqual(["m-a", "m-b"]);
    // net = 10 001; parts 5 001 (m-a, first in order) and 5 000 (m-b)
    const byUser = Object.fromEntries(
      result.payouts.map((p) => [p.userId, p.lamports]),
    );
    expect(byUser).toEqual({ u1: BigInt(5_001), u2: BigInt(5_000) });
  });

  it("passes an unbacked tied winner's share to the backed ones", () => {
    const result = settleSolPool({
      wagers: [
        wager("w1", "u1", "m-a", BigInt(2_000)),
        wager("w2", "u2", "m-b", BigInt(2_000)),
      ],
      winnerModelIds: ["m-a", "m-c"],
      modelOrder: MODELS,
      feeBps: 1000,
    });
    expect(result.kind).toBe("settled");
    expect(result.winners).toEqual(["m-a"]);
    expect(result.reason).toBe("settled");
    expect(result.payouts).toEqual([
      expect.objectContaining({ userId: "u1", lamports: BigInt(3_600) }),
    ]);
  });

  it.each([
    ["voided", { voided: true, winnerModelIds: ["m-a"] }],
    ["no_winner", { winnerModelIds: [] }],
    ["winner_unbacked", { winnerModelIds: ["m-c"] }],
  ] as const)("refunds in full with no fee when %s", (reason, extra) => {
    const wagers = [
      wager("w1", "u1", "m-a", BigInt(1_234)),
      wager("w2", "u1", "m-b", BigInt(1)),
      wager("w3", "u2", "m-b", BigInt(5_000)),
    ];
    const result = settleSolPool({
      wagers,
      modelOrder: MODELS,
      feeBps: 500,
      ...extra,
    });
    expect(result.kind).toBe("refund");
    expect(result.reason).toBe(reason);
    expect(result.fee).toBe(BigInt(0));
    expect(result.winners).toEqual([]);
    expect(result.wagerOutcomes.every((o) => o.outcome === "refunded")).toBe(
      true,
    );
    expect(result.payouts).toEqual([
      {
        userId: "u1",
        walletAddress: "wallet-u1",
        kind: "refund",
        lamports: BigInt(1_235),
        wagerIds: ["w1", "w2"],
      },
      {
        userId: "u2",
        walletAddress: "wallet-u2",
        kind: "refund",
        lamports: BigInt(5_000),
        wagerIds: ["w3"],
      },
    ]);
  });

  it("conserves the pool exactly across random pools, including huge values", () => {
    const rand = prng(20261120);
    for (let round = 0; round < 400; round += 1) {
      const count = 1 + Math.floor(rand() * 12);
      const huge = round % 4 === 0;
      const wagers: SolWager[] = [];
      for (let i = 0; i < count; i += 1) {
        const lamports = huge
          ? BigInt(10) ** BigInt(18) + BigInt(Math.floor(rand() * 1e9))
          : BigInt(1) + BigInt(Math.floor(rand() * 5e9));
        wagers.push(
          wager(
            `w${round}-${i}`,
            `u${Math.floor(rand() * 5)}`,
            MODELS[Math.floor(rand() * 3)],
            lamports,
          ),
        );
      }
      const winnerModelIds = MODELS.filter(() => rand() < 0.5);
      const feeBps = Math.floor(rand() * 2001);
      const result = settleSolPool({
        wagers,
        winnerModelIds,
        modelOrder: MODELS,
        feeBps,
      });

      const gross = sum(wagers.map((w) => w.lamports));
      const paid = sum(result.payouts.map((p) => p.lamports));
      expect(result.gross).toBe(gross);
      expect(paid + result.fee).toBe(gross);
      expect(
        sum(result.wagerOutcomes.map((o) => o.lamports)) + result.fee,
      ).toBe(gross);
      if (result.kind === "refund") expect(result.fee).toBe(BigInt(0));
      else expect(result.fee).toBe(computeFee(gross, feeBps));
    }
  });

  it("is independent of input order", () => {
    const rand = prng(7);
    const wagers: SolWager[] = Array.from({ length: 25 }, (_, i) =>
      wager(
        `w${String(i).padStart(2, "0")}`,
        `u${i % 6}`,
        MODELS[i % 3],
        BigInt(1 + ((i * 7919) % 1_000)),
      ),
    );
    const base = settleSolPool({
      wagers,
      winnerModelIds: ["m-a", "m-b"],
      modelOrder: MODELS,
      feeBps: 500,
    });
    for (let i = 0; i < 20; i += 1) {
      const shuffled = settleSolPool({
        wagers: shuffle(wagers, rand),
        winnerModelIds: shuffle(["m-a", "m-b"], rand),
        modelOrder: MODELS,
        feeBps: 500,
      });
      expect(shuffled).toEqual(base);
    }
  });

  it("orders winners missing from modelOrder after the listed ones, by id", () => {
    const result = settleSolPool({
      wagers: [
        wager("w1", "u1", "z-x", BigInt(1)),
        wager("w2", "u2", "a-y", BigInt(1)),
        wager("w3", "u3", "m-b", BigInt(1)),
      ],
      winnerModelIds: ["z-x", "a-y", "m-b"],
      modelOrder: MODELS,
      feeBps: 0,
    });
    expect(result.winners).toEqual(["m-b", "a-y", "z-x"]);
  });

  it("rejects invalid wagers", () => {
    const base = { winnerModelIds: ["m-a"], modelOrder: MODELS, feeBps: 0 };
    expect(() =>
      settleSolPool({ ...base, wagers: [wager("w1", "u1", "m-a", BigInt(0))] }),
    ).toThrow();
    expect(() =>
      settleSolPool({
        ...base,
        wagers: [wager("w1", "u1", "m-a", -BigInt(5))],
      }),
    ).toThrow();
    expect(() =>
      settleSolPool({
        ...base,
        wagers: [
          {
            ...wager("w1", "u1", "m-a", BigInt(1)),
            lamports: 5 as unknown as bigint,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      settleSolPool({
        ...base,
        wagers: [
          wager("w1", "u1", "m-a", BigInt(1)),
          wager("w1", "u2", "m-a", BigInt(1)),
        ],
      }),
    ).toThrow(/Duplicate/);
    expect(() =>
      settleSolPool({ ...base, feeBps: 5000, wagers: [] }),
    ).toThrow();
  });
});

describe("formatSol / parseSolToLamports", () => {
  it("formats lamports as SOL", () => {
    expect(formatSol(BigInt(1_500_000_000))).toBe("1.5");
    expect(formatSol(LAMPORTS_PER_SOL)).toBe("1");
    expect(formatSol(BigInt(0))).toBe("0");
    expect(formatSol(BigInt(33_333_333))).toBe("0.0333");
    expect(formatSol(BigInt(33_333_333), 9)).toBe("0.033333333");
    expect(formatSol(BigInt(1), 9)).toBe("0.000000001");
  });

  it("parses SOL text to lamports", () => {
    expect(parseSolToLamports("1.5")).toBe(BigInt(1_500_000_000));
    expect(parseSolToLamports(" 0.000000001 ")).toBe(BigInt(1));
    expect(parseSolToLamports("2")).toBe(BigInt(2_000_000_000));
  });

  it("round-trips at full precision", () => {
    for (const lamports of [
      BigInt(1),
      BigInt(999),
      BigInt(33_333_333),
      BigInt(10) ** BigInt(18) + BigInt(7),
    ]) {
      expect(parseSolToLamports(formatSol(lamports, 9))).toBe(lamports);
    }
  });

  it("rejects invalid or negative text", () => {
    for (const bad of ["", "-1", "1.0000000001", "abc", "1e3", ".5", "1."]) {
      expect(() => parseSolToLamports(bad)).toThrow();
    }
  });
});
