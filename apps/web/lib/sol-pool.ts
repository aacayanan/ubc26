/**
 * SOL parimutuel pool: pure, exact-integer math (Devnet prototype).
 *
 * Every amount is a `bigint` of lamports. Plain `number` arithmetic is not safe
 * here: `stake × pot` in lamports passes 2^53 long before a pool is large
 * (1 SOL × 100 SOL ≈ 10^20), and a silent rounding error in a payout is a
 * correctness bug, not a cosmetic one.
 *
 * No I/O and no `server-only` import: the client uses `estimatePool` for the
 * live multiplier readout, and settlement uses `settleSolPool`. Both read the
 * same fee rule, so the estimate a bettor sees and the split they receive come
 * from one definition.
 *
 * Rules kept here, each tested:
 *   * **Conservation.** settled: Σ payouts + fee = gross; refund: Σ payouts =
 *     gross. Checked at runtime, and a mismatch throws instead of paying.
 *   * **Determinism.** Every tie is broken by a stable key (model order, then
 *     wager id), never by input order.
 *   * **Dead heat.** Tied winners split the net pool equally per model, then
 *     pro-rata inside each model. The crowd vote is not an input.
 *   * **No fee on a refund.** Void, no winner, or an unbacked winner returns
 *     every wager in full.
 */

export const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

/** The largest fee a round may configure: 20%. */
export const MAX_FEE_BPS = 2000;

export interface SolWager {
  wagerId: string;
  userId: string;
  walletAddress: string;
  modelId: string;
  lamports: bigint;
}

export function computeFee(gross: bigint, feeBps: number): bigint {
  assertFeeBps(feeBps);
  if (typeof gross !== "bigint" || gross < BigInt(0)) {
    throw new Error("gross must be a non-negative bigint of lamports");
  }
  return (gross * BigInt(feeBps)) / BigInt(10_000);
}

export interface PoolEstimate {
  gross: bigint;
  fee: bigint;
  net: bigint;
  models: Array<{
    modelId: string;
    staked: bigint;
    /** Share of the gross pool riding on this model, 0..1 (display only). */
    share: number;
    /** Estimated return per 1 staked if this model wins alone; null = no backers. */
    multiplier: number | null;
  }>;
}

/**
 * Estimated multipliers for display while betting is open.
 *
 * `multiplier = net / staked`, the single-winner case. A dead heat would pay
 * less, which is why the UI must call this an estimate. Wagers on a model not in
 * `modelIds` still count toward the pool: dropping them would overstate every
 * multiplier.
 */
export function estimatePool(input: {
  modelIds: readonly string[];
  wagers: ReadonlyArray<{ modelId: string; lamports: bigint }>;
  feeBps: number;
}): PoolEstimate {
  const { modelIds, wagers, feeBps } = input;
  const byModel = new Map<string, bigint>();
  let gross = BigInt(0);

  for (const wager of wagers) {
    assertLamports(wager.lamports);
    gross += wager.lamports;
    byModel.set(
      wager.modelId,
      (byModel.get(wager.modelId) ?? BigInt(0)) + wager.lamports,
    );
  }

  const fee = computeFee(gross, feeBps);
  const net = gross - fee;

  return {
    gross,
    fee,
    net,
    models: modelIds.map((modelId) => {
      const staked = byModel.get(modelId) ?? BigInt(0);
      return {
        modelId,
        staked,
        share: gross > BigInt(0) ? ratio(staked, gross) : 0,
        multiplier:
          staked > BigInt(0)
            ? Number((net * BigInt(100)) / staked) / 100
            : null,
      };
    }),
  };
}

export type SolSettlementKind = "settled" | "refund";

export interface UserPayout {
  userId: string;
  walletAddress: string;
  kind: "winnings" | "refund";
  lamports: bigint;
  wagerIds: string[];
}

export interface SolSettlement {
  kind: SolSettlementKind;
  /** "settled" | "dead_heat" | "voided" | "no_winner" | "winner_unbacked". */
  reason: string;
  gross: bigint;
  fee: bigint;
  net: bigint;
  /** Backed winning models, in payout order. Empty on a refund. */
  winners: string[];
  wagerOutcomes: Array<{
    wagerId: string;
    outcome: "won" | "lost" | "refunded";
    lamports: bigint;
  }>;
  payouts: UserPayout[];
}

export function settleSolPool(input: {
  wagers: readonly SolWager[];
  winnerModelIds: readonly string[];
  modelOrder: readonly string[];
  feeBps: number;
  voided?: boolean;
}): SolSettlement {
  const { winnerModelIds, modelOrder, feeBps } = input;
  assertFeeBps(feeBps);

  const seen = new Set<string>();
  for (const wager of input.wagers) {
    assertLamports(wager.lamports);
    if (seen.has(wager.wagerId)) {
      throw new Error(`Duplicate wager id ${wager.wagerId}`);
    }
    seen.add(wager.wagerId);
  }

  // Sort once by wager id: every later step is then independent of input order.
  const wagers = [...input.wagers].sort((a, b) => cmp(a.wagerId, b.wagerId));
  const gross = wagers.reduce((sum, w) => sum + w.lamports, BigInt(0));

  const stakedBy = new Map<string, bigint>();
  for (const w of wagers) {
    stakedBy.set(
      w.modelId,
      (stakedBy.get(w.modelId) ?? BigInt(0)) + w.lamports,
    );
  }

  const uniqueWinners = [...new Set(winnerModelIds)];
  const backedWinners = orderModels(
    uniqueWinners.filter((id) => (stakedBy.get(id) ?? BigInt(0)) > BigInt(0)),
    modelOrder,
  );

  const refundReason = input.voided
    ? "voided"
    : uniqueWinners.length === 0
      ? "no_winner"
      : backedWinners.length === 0
        ? "winner_unbacked"
        : null;

  if (refundReason) {
    const wagerOutcomes = wagers.map((w) => ({
      wagerId: w.wagerId,
      outcome: "refunded" as const,
      lamports: w.lamports,
    }));
    const payouts = aggregate(wagers, wagerOutcomes, "refund");
    assertConserved(payouts, BigInt(0), gross);
    return {
      kind: "refund",
      reason: refundReason,
      gross,
      fee: BigInt(0),
      net: gross,
      winners: [],
      wagerOutcomes,
      payouts,
    };
  }

  const fee = computeFee(gross, feeBps);
  const net = gross - fee;

  // Dead heat: equal parts per backed winner, the remainder lamport by lamport
  // in model order.
  const k = BigInt(backedWinners.length);
  const base = net / k;
  let remainder = net % k;
  const parts = new Map<string, bigint>();
  for (const modelId of backedWinners) {
    const extra = remainder > BigInt(0) ? BigInt(1) : BigInt(0);
    remainder -= extra;
    parts.set(modelId, base + extra);
  }

  const awarded = new Map<string, bigint>();
  for (const modelId of backedWinners) {
    const backers = wagers.filter((w) => w.modelId === modelId);
    const staked = stakedBy.get(modelId)!;
    const part = parts.get(modelId)!;
    for (const [wagerId, amount] of splitLargestRemainder(
      backers,
      part,
      staked,
    )) {
      awarded.set(wagerId, amount);
    }
  }

  const wagerOutcomes = wagers.map((w) => {
    const amount = awarded.get(w.wagerId);
    return amount === undefined
      ? { wagerId: w.wagerId, outcome: "lost" as const, lamports: BigInt(0) }
      : { wagerId: w.wagerId, outcome: "won" as const, lamports: amount };
  });

  const payouts = aggregate(wagers, wagerOutcomes, "winnings");
  assertConserved(payouts, fee, gross);

  return {
    kind: "settled",
    reason: backedWinners.length > 1 ? "dead_heat" : "settled",
    gross,
    fee,
    net,
    winners: backedWinners,
    wagerOutcomes,
    payouts,
  };
}

/** `BigInt(1_500_000_000)` → `"1.5"`. Truncates (never rounds up) past `maxDecimals`. */
export function formatSol(lamports: bigint, maxDecimals = 4): string {
  if (!Number.isInteger(maxDecimals) || maxDecimals < 0 || maxDecimals > 9) {
    throw new Error("maxDecimals must be an integer between 0 and 9");
  }
  const negative = lamports < BigInt(0);
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, "0")
    .slice(0, maxDecimals)
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** `"1.5"` → `BigInt(1_500_000_000)`. At most 9 decimals; rejects negatives and junk. */
export function parseSolToLamports(text: string): bigint {
  const trimmed = text.trim();
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`"${text}" is not a valid SOL amount`);
  }
  const whole = BigInt(match[1]);
  const frac = BigInt((match[2] ?? "").padEnd(9, "0"));
  return whole * LAMPORTS_PER_SOL + frac;
}

// ---------------------------------------------------------------------------

function splitLargestRemainder(
  backers: readonly SolWager[],
  part: bigint,
  staked: bigint,
): Array<[string, bigint]> {
  const rows = backers.map((w) => {
    const scaled = w.lamports * part;
    return {
      wagerId: w.wagerId,
      amount: scaled / staked,
      remainder: scaled % staked,
    };
  });

  let unassigned = part - rows.reduce((sum, r) => sum + r.amount, BigInt(0));
  const ordered = [...rows].sort((a, b) =>
    a.remainder !== b.remainder
      ? a.remainder > b.remainder
        ? -1
        : 1
      : cmp(a.wagerId, b.wagerId),
  );
  // Fewer than backers.length lamports remain, so one pass is enough.
  for (let i = 0; unassigned > BigInt(0); i += 1, unassigned -= BigInt(1)) {
    ordered[i % ordered.length].amount += BigInt(1);
  }
  return rows.map((r) => [r.wagerId, r.amount]);
}

/**
 * One payout per user. The wallet is the one on the user's lowest-id wager, an
 * order-independent stand-in for "first wager". In practice an account has one
 * linked wallet, so every wager carries the same address.
 */
function aggregate(
  wagers: readonly SolWager[],
  outcomes: ReadonlyArray<{ wagerId: string; lamports: bigint }>,
  kind: UserPayout["kind"],
): UserPayout[] {
  const amountById = new Map(outcomes.map((o) => [o.wagerId, o.lamports]));
  const byUser = new Map<string, UserPayout>();

  // `wagers` is sorted by wager id, so the first wager seen per user is the
  // lowest id.
  for (const w of wagers) {
    const amount = amountById.get(w.wagerId) ?? BigInt(0);
    let payout = byUser.get(w.userId);
    if (!payout) {
      payout = {
        userId: w.userId,
        walletAddress: w.walletAddress,
        kind,
        lamports: BigInt(0),
        wagerIds: [],
      };
      byUser.set(w.userId, payout);
    }
    if (amount > BigInt(0)) {
      payout.lamports += amount;
      payout.wagerIds.push(w.wagerId);
    }
  }

  return [...byUser.values()]
    .filter((p) => p.lamports > BigInt(0))
    .map((p) => ({ ...p, wagerIds: [...p.wagerIds].sort(cmp) }))
    .sort((a, b) => cmp(a.userId, b.userId));
}

function orderModels(
  ids: readonly string[],
  modelOrder: readonly string[],
): string[] {
  const rank = new Map(modelOrder.map((id, index) => [id, index]));
  return [...ids].sort((a, b) => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return cmp(a, b);
  });
}

function assertConserved(
  payouts: readonly UserPayout[],
  fee: bigint,
  gross: bigint,
) {
  const paid = payouts.reduce((sum, p) => sum + p.lamports, BigInt(0));
  if (paid + fee !== gross) {
    throw new Error(
      `Pool not conserved: paid ${paid} + fee ${fee} != gross ${gross}`,
    );
  }
}

function assertLamports(value: bigint) {
  if (typeof value !== "bigint" || value <= BigInt(0)) {
    throw new Error("A wager must be a positive bigint of lamports");
  }
}

function assertFeeBps(feeBps: number) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    throw new Error(`feeBps must be an integer between 0 and ${MAX_FEE_BPS}`);
  }
}

/** A 0..1 ratio of two bigints, precise to 1e-6, for display only. */
function ratio(part: bigint, whole: bigint): number {
  return Number((part * BigInt(1_000_000)) / whole) / 1_000_000;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
