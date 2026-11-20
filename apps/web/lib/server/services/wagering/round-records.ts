import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { InternalError, NotFoundError } from "@/lib/server/errors/app-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getDevnetConnection } from "@/lib/server/integrations/solana/connection";
import { explorerTxUrl } from "@/lib/server/integrations/solana/config";
import { readTransactionMemos } from "@/lib/server/integrations/solana/transactions";
import {
  MEMO_VERSION,
  legacySettleMemo,
  roundMemo,
  settleMemo,
} from "./commitment";
import {
  recordOperatorMemo,
  type OperatorRecordPurpose,
} from "./chain-records";

/**
 * F21 / F22 — a round's operator records, as anyone can see and check them.
 *
 * Public: every field here is already public on Devnet (memo text, signature)
 * or is the round's own public data. A record is correlated to its round by
 * the round id inside the memo, and `matchesRound` re-derives what the memo
 * must say from the round row — so the deadline on-chain is shown to be the
 * same instant as `rounds.prediction_deadline`, not merely a similar one.
 *
 * A settlement record (F22) is checked twice: its memo against the stored
 * `rounds.sol_settlement` (`matchesRound`), and that settlement against the
 * round's outcome and per-model results (`matchesOutcome`) — so the published
 * summary is shown to agree with what the round actually decided.
 *
 * Status is reported as stored: only `confirmed` is ever presented as on-chain;
 * `pending` / `timeout` / `failed` are shown as such (the retry job resends
 * them).
 */

export interface RoundRowForRecords {
  id: string;
  prediction_deadline: string;
  token_budget_per_model: number | null;
  cutoff_bps: number;
  fee_bps: number;
  treasury_address: string | null;
  betting_closed_at: string | null;
  betting_close_reason: string | null;
  status?: string;
  sol_settlement?: SolSettlementRow | null;
}

/** `rounds.sol_settlement`, as `record_sol_settlement` writes it. */
export interface SolSettlementRow {
  kind: string;
  reason: string;
  winnerModelIds: string[];
  grossLamports: string;
  feeLamports: string;
  netLamports: string;
  payoutCount: number;
}

export interface OutcomeFacts {
  /** `round_outcomes.kind` ('settled' | 'voided'), or null when there is none. */
  outcomeKind: string | null;
  outcomeWinnerId: string | null;
  /** Models whose conformance result is `conformed`. */
  conformedModelIds: string[];
}

/**
 * Pure: does the settlement agree with the round's outcome and results?
 *
 *   settled / dead_heat      every winner conformed, the outcome is `settled`,
 *                            and the outcome's winner is among the conformers
 *   refund: voided           the outcome is `voided` (or absent: cancelled)
 *   refund: no_winner        no model conformed
 *   refund: winner_unbacked  a model conformed, but nobody backed it
 */
export function checkSettlementOutcome(
  settlement: SolSettlementRow,
  facts: OutcomeFacts,
): { ok: boolean; detail: string } {
  const conformed = new Set(facts.conformedModelIds);
  if (settlement.kind === "settled") {
    const winners = settlement.winnerModelIds;
    if (winners.length === 0) {
      return { ok: false, detail: "A paid settlement names no winner." };
    }
    if (!winners.every((id) => conformed.has(id))) {
      return { ok: false, detail: "A winning model did not conform." };
    }
    if (facts.outcomeKind !== "settled") {
      return { ok: false, detail: "The round's outcome is not settled." };
    }
    if (facts.outcomeWinnerId && !conformed.has(facts.outcomeWinnerId)) {
      return { ok: false, detail: "The outcome's winner did not conform." };
    }
    return { ok: true, detail: "Paid to backers of the conforming model(s)." };
  }
  if (settlement.kind === "refund") {
    if (settlement.winnerModelIds.length > 0) {
      return { ok: false, detail: "A refund names a winner." };
    }
    switch (settlement.reason) {
      case "voided":
        return facts.outcomeKind === null || facts.outcomeKind === "voided"
          ? {
              ok: true,
              detail: "The round was void, so every wager was refunded.",
            }
          : { ok: false, detail: "Refunded as void, but the round settled." };
      case "no_winner":
        return conformed.size === 0
          ? {
              ok: true,
              detail: "No model conformed, so every wager was refunded.",
            }
          : {
              ok: false,
              detail: "Refunded for no winner, but a model conformed.",
            };
      case "winner_unbacked":
        return conformed.size > 0
          ? {
              ok: true,
              detail:
                "A model conformed but nobody backed it, so every wager was refunded.",
            }
          : {
              ok: false,
              detail: "Refunded as unbacked, but nothing conformed.",
            };
      default:
        return {
          ok: false,
          detail: `Unknown refund reason "${settlement.reason}".`,
        };
    }
  }
  return { ok: false, detail: `Unknown settlement kind "${settlement.kind}".` };
}

/** The memo a settlement must carry: current format first, then legacy. */
export function settlementMemos(
  roundId: string,
  settlement: SolSettlementRow,
): string[] {
  const facts = {
    roundId,
    kind: settlement.kind,
    winners: settlement.winnerModelIds,
    gross: settlement.grossLamports,
    fee: settlement.feeLamports,
    net: settlement.netLamports,
    payoutCount: settlement.payoutCount,
  };
  return [
    settleMemo({ ...facts, reason: settlement.reason }),
    // Records published before the reason was added to the memo.
    legacySettleMemo(facts),
  ];
}

export interface RoundRecordCheck {
  /** The memo the round row says this record must carry (or its prefix). */
  expected: string | null;
  /** True when the stored memo agrees with the round row. */
  matchesRound: boolean | null;
}

/** Pure: what a round's record must say, derived from the round row. */
export function expectedRecord(
  purpose: OperatorRecordPurpose,
  round: RoundRowForRecords,
): { exact: string } | { prefix: string } | { anyOf: string[] } | null {
  if (purpose === "round_record") {
    if (!round.treasury_address || round.token_budget_per_model === null) {
      return null;
    }
    return {
      exact: roundMemo({
        roundId: round.id,
        anteDeadline: round.prediction_deadline,
        budgetTokens: round.token_budget_per_model,
        cutoffBps: round.cutoff_bps,
        feeBps: round.fee_bps,
        treasury: round.treasury_address,
      }),
    };
  }
  if (purpose === "betting_close") {
    if (!round.betting_closed_at || !round.betting_close_reason) return null;
    // The trailing snapshot hash is evidence of the meters at close; it is
    // opaque here (jsonb does not preserve the key order it was hashed in).
    return {
      prefix: `${MEMO_VERSION}:close:${round.id}:${round.betting_close_reason}:${new Date(round.betting_closed_at).toISOString()}:`,
    };
  }
  if (purpose === "settlement") {
    if (!round.sol_settlement) return null;
    return { anyOf: settlementMemos(round.id, round.sol_settlement) };
  }
  return null;
}

export function checkRecord(
  purpose: OperatorRecordPurpose,
  memo: string,
  round: RoundRowForRecords,
): RoundRecordCheck {
  const expected = expectedRecord(purpose, round);
  if (!expected) return { expected: null, matchesRound: null };
  if ("anyOf" in expected) {
    return {
      expected: expected.anyOf[0],
      matchesRound: expected.anyOf.includes(memo),
    };
  }
  return "exact" in expected
    ? { expected: expected.exact, matchesRound: memo === expected.exact }
    : {
        expected: expected.prefix,
        matchesRound: memo.startsWith(expected.prefix),
      };
}

export interface RoundChainRecord {
  purpose: OperatorRecordPurpose;
  status: string;
  signature: string | null;
  explorerUrl: string | null;
  memo: string;
  slot: number | null;
  confirmedAt: string | null;
  /** Stored memo vs what the round row says it must be. */
  matchesRound: boolean | null;
  /** Settlement only: the settlement vs the round's outcome and results. */
  matchesOutcome: boolean | null;
  /** Settlement only: the published summary, readable. */
  settlement: {
    kind: string;
    reason: string;
    winners: string[];
    grossLamports: string;
    feeLamports: string;
    netLamports: string;
    payoutCount: number;
    detail: string;
  } | null;
  /** Filled only when `checkChain` is requested. */
  onChain: {
    found: boolean;
    memoMatches: boolean;
    operatorSigned: boolean;
    blockTime: string | null;
  } | null;
}

export interface RoundChainRecords {
  roundId: string;
  anteDeadline: string;
  records: RoundChainRecord[];
}

const ROUND_COLUMNS =
  "id, status, prediction_deadline, token_budget_per_model, cutoff_bps, fee_bps, treasury_address, betting_closed_at, betting_close_reason, sol_settlement";

/** The round's outcome, conformers and model names, for a settlement check. */
async function readOutcomeFacts(
  supabase: SupabaseClient,
  roundId: string,
  modelIds: string[],
): Promise<{ facts: OutcomeFacts; names: Map<string, string> }> {
  const [outcomeRead, resultsRead] = await Promise.all([
    supabase
      .from("round_outcomes")
      .select("kind, winner_model_id")
      .eq("round_id", roundId)
      .maybeSingle(),
    supabase
      .from("competition_results")
      .select("model_id, status")
      .eq("round_id", roundId)
      .eq("category", "conformance"),
  ]);
  if (outcomeRead.error || resultsRead.error) {
    throw new InternalError(
      "Failed to read the round's outcome",
      outcomeRead.error ?? resultsRead.error,
    );
  }
  const names = new Map<string, string>();
  if (modelIds.length > 0) {
    const { data: models } = await supabase
      .from("llm_models")
      .select("id, name")
      .in("id", modelIds);
    for (const model of (models ?? []) as Array<{ id: string; name: string }>) {
      names.set(model.id, model.name);
    }
  }
  const outcome = outcomeRead.data as {
    kind: string;
    winner_model_id: string | null;
  } | null;
  const results = (resultsRead.data ?? []) as Array<{
    model_id: string;
    status: string;
  }>;
  return {
    facts: {
      outcomeKind: outcome?.kind ?? null,
      outcomeWinnerId: outcome?.winner_model_id ?? null,
      conformedModelIds: results
        .filter((result) => result.status === "conformed")
        .map((result) => result.model_id),
    },
    names,
  };
}

export async function getRoundChainRecords(
  roundId: string,
  options: {
    purposes?: OperatorRecordPurpose[];
    checkChain?: boolean;
    supabase?: SupabaseClient;
  } = {},
): Promise<RoundChainRecords> {
  const supabase = options.supabase ?? getServiceRoleSupabase();
  const purposes = options.purposes ?? [
    "round_record",
    "betting_close",
    "settlement",
  ];

  const { data: roundData, error: roundError } = await supabase
    .from("rounds")
    .select(ROUND_COLUMNS)
    .eq("id", roundId)
    .maybeSingle();
  if (roundError)
    throw new InternalError("Failed to read the round", roundError);
  if (!roundData) throw new NotFoundError("Round not found");
  const round = roundData as RoundRowForRecords;

  const { data, error } = await supabase
    .from("blockchain_transactions")
    .select(
      "purpose, status, signature, slot, confirmed_at, wallet_address, payload",
    )
    .eq("round_id", roundId)
    .in("purpose", purposes)
    .order("created_at", { ascending: true });
  if (error)
    throw new InternalError("Failed to read the round's records", error);

  const rows = (data ?? []) as Array<{
    purpose: OperatorRecordPurpose;
    status: string;
    signature: string | null;
    slot: number | null;
    confirmed_at: string | null;
    wallet_address: string | null;
    payload: { memo?: unknown } | null;
  }>;

  const settlementRow = round.sol_settlement ?? null;
  const outcome =
    settlementRow && rows.some((row) => row.purpose === "settlement")
      ? await readOutcomeFacts(supabase, roundId, settlementRow.winnerModelIds)
      : null;

  const connection = options.checkChain ? await getDevnetConnection() : null;
  const records: RoundChainRecord[] = [];
  for (const row of rows) {
    const memo = typeof row.payload?.memo === "string" ? row.payload.memo : "";
    const confirmed = row.status === "confirmed" && row.signature !== null;
    let onChain: RoundChainRecord["onChain"] = null;
    if (connection && confirmed) {
      const landed = await readTransactionMemos(connection, row.signature!);
      onChain = {
        found: landed.found && !landed.failed,
        memoMatches: landed.memos.includes(memo),
        operatorSigned:
          row.wallet_address !== null &&
          landed.signers.includes(row.wallet_address),
        blockTime: landed.blockTime,
      };
    }
    records.push({
      purpose: row.purpose,
      status: row.status,
      // A signature is only a link once it is confirmed; before that it may
      // never land, and a link would suggest otherwise.
      signature: confirmed ? row.signature : null,
      explorerUrl: confirmed ? explorerTxUrl(row.signature!) : null,
      memo,
      slot: confirmed ? row.slot : null,
      confirmedAt: confirmed ? row.confirmed_at : null,
      matchesRound: checkRecord(row.purpose, memo, round).matchesRound,
      ...settlementFields(row.purpose, settlementRow, outcome),
      onChain,
    });
  }

  return {
    roundId,
    anteDeadline: new Date(round.prediction_deadline).toISOString(),
    records,
  };
}

function settlementFields(
  purpose: OperatorRecordPurpose,
  settlement: SolSettlementRow | null,
  outcome: { facts: OutcomeFacts; names: Map<string, string> } | null,
): Pick<RoundChainRecord, "matchesOutcome" | "settlement"> {
  if (purpose !== "settlement" || !settlement || !outcome) {
    return { matchesOutcome: null, settlement: null };
  }
  const verdict = checkSettlementOutcome(settlement, outcome.facts);
  return {
    matchesOutcome: verdict.ok,
    settlement: {
      kind: settlement.kind,
      reason: settlement.reason,
      winners: settlement.winnerModelIds.map(
        (id) => outcome.names.get(id) ?? id,
      ),
      grossLamports: settlement.grossLamports,
      feeLamports: settlement.feeLamports,
      netLamports: settlement.netLamports,
      payoutCount: settlement.payoutCount,
      detail: verdict.detail,
    },
  };
}

/**
 * Record the settlement memo for any settled SOL round that has none
 * (internal job). Settlement fires its memo once, in the background; if that
 * process died before the record row was written, nothing would retry it.
 * The memo is derived from the stored settlement, exactly as checked.
 */
export async function backfillSettlementRecords(input: {
  roundId?: string;
  limit?: number;
}): Promise<Record<string, number>> {
  const supabase = getServiceRoleSupabase();
  let query = supabase
    .from("rounds")
    .select(ROUND_COLUMNS)
    .eq("wagering_mode", "devnet_sol")
    .not("sol_settlement", "is", null)
    .order("created_at", { ascending: true })
    .limit(input.limit ?? 25);
  if (input.roundId) query = query.eq("id", input.roundId);
  const { data, error } = await query;
  if (error) throw new InternalError("Failed to list settled rounds", error);
  const rounds = (data ?? []) as RoundRowForRecords[];
  if (rounds.length === 0) return {};

  const { data: existing, error: existingError } = await supabase
    .from("blockchain_transactions")
    .select("round_id")
    .eq("purpose", "settlement")
    .in(
      "round_id",
      rounds.map((round) => round.id),
    );
  if (existingError) {
    throw new InternalError("Failed to read settlement records", existingError);
  }
  const recorded = new Set(
    (existing ?? []).map((row) => (row as { round_id: string }).round_id),
  );

  const tally: Record<string, number> = {};
  for (const round of rounds) {
    if (recorded.has(round.id) || !round.sol_settlement) continue;
    const result = await recordOperatorMemo({
      purpose: "settlement",
      idempotencyKey: `settle:${round.id}`,
      roundId: round.id,
      memo: settlementMemos(round.id, round.sol_settlement)[0],
    });
    tally[result.status] = (tally[result.status] ?? 0) + 1;
  }
  return tally;
}

/**
 * Record the round memo for any open SOL round that has none (internal job).
 *
 * The admin route records a round when it creates it; rounds created any
 * other way (scripts, direct RPC calls) would otherwise never be recorded.
 * Only rounds whose ante deadline is still ahead are recorded, so the record
 * on-chain always predates the deadline it states. The memo is derived from
 * the round row, exactly as `expectedRecord` checks it.
 */
export async function backfillRoundRecords(input: {
  roundId?: string;
  limit?: number;
}): Promise<Record<string, number>> {
  const supabase = getServiceRoleSupabase();
  let query = supabase
    .from("rounds")
    .select(ROUND_COLUMNS)
    .eq("wagering_mode", "devnet_sol")
    .eq("status", "OPEN")
    .gt("prediction_deadline", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(input.limit ?? 25);
  if (input.roundId) query = query.eq("id", input.roundId);
  const { data, error } = await query;
  if (error) throw new InternalError("Failed to list open rounds", error);
  const rounds = (data ?? []) as RoundRowForRecords[];
  if (rounds.length === 0) return {};

  const { data: existing, error: existingError } = await supabase
    .from("blockchain_transactions")
    .select("round_id")
    .eq("purpose", "round_record")
    .in(
      "round_id",
      rounds.map((round) => round.id),
    );
  if (existingError) {
    throw new InternalError("Failed to read round records", existingError);
  }
  const recorded = new Set(
    (existing ?? []).map((row) => (row as { round_id: string }).round_id),
  );

  const tally: Record<string, number> = {};
  for (const round of rounds) {
    if (recorded.has(round.id)) continue;
    const expected = expectedRecord("round_record", round);
    if (!expected || !("exact" in expected)) {
      tally.skipped = (tally.skipped ?? 0) + 1;
      continue;
    }
    const result = await recordOperatorMemo({
      purpose: "round_record",
      idempotencyKey: `round:${round.id}`,
      roundId: round.id,
      memo: expected.exact,
    });
    tally[result.status] = (tally[result.status] ?? 0) + 1;
  }
  return tally;
}
