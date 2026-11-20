import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { InternalError } from "@/lib/server/errors/app-error";

/**
 * F25 — historical model performance across settled rounds.
 *
 * Two records that are never merged, because they answer different questions:
 *
 *   * **conformance** — how often the judge ruled the model's render followed
 *     the brief. This is the measured, objective record.
 *   * **crowd** — how often the crowd named the model best (the fan-favorite
 *     vote). This is the subjective record.
 *
 * Speed and code length are deliberately absent. They belonged to the retired
 * pre-pivot format (REQUIREMENTS.md pivot notice); the post-pivot F25 line is
 * conformance rate and crowd win rate, and the retired wording must not return
 * (CLAUDE.md interface system).
 *
 * The reads come from `model_round_analytics` (migration 20261119001200): one
 * row per model per *comparable, decided* round, keyed off `round_models` so a
 * model seated in a round that failed before settlement still appears — with
 * the round labeled, not dropped. The rate arithmetic lives here, pure and
 * unit-tested, rather than in the view, so the rules are testable the way F15's
 * resolver and F24's rankings are.
 */

/** A round's place in a model's history. */
export type ModelRoundOutcome = "settled" | "voided" | "unsettled";

/** The conformance status settlement recorded, when it recorded one. */
export type ModelConformanceRow =
  "conformed" | "not_conformed" | "forfeited" | "unavailable";

/** One comparable round, as it counts toward a model's history. */
export interface ModelRoundFact {
  roundId: string;
  roundSlug: string;
  briefTitle: string;
  outcome: ModelRoundOutcome;
  /** The model's recorded conformance, or null when none was written. */
  conformance: ModelConformanceRow | null;
  winnerModelId: string | null;
  fanFavoriteModelId: string | null;
  decidedAt: string;
}

export interface ModelHistory {
  modelId: string;
  name: string;
  /** Comparable rounds the model was seated in (settled + voided + unsettled). */
  rounds: number;
  /** Rounds it settled, i.e. the denominator for the two rates. */
  settledRounds: number;
  /** Judge rulings of `conformed`. */
  conformanceWins: number;
  /** Times it was the conforming winner of a settled round. */
  roundWins: number;
  /** Times the crowd named it best. */
  crowdWins: number;
  /** Renders that failed the deterministic gate (never judged). */
  forfeits: number;
  /** Conformance status the judge ruled, 0..1, or null with no decided rounds. */
  conformanceRate: number | null;
  /** Share of the crowd's picks that named this model, 0..1, or null. */
  crowdWinRate: number | null;
  /** Rounds in the model's history that produced no result, labeled not hidden. */
  voidedRounds: number;
  unsettledRounds: number;
  /** Most recent decided round first, capped for the panel. */
  recent: ModelRoundFact[];
}

export interface ModelAnalytics {
  models: ModelHistory[];
  /** Comparable rounds that did not settle, newest first, so the page lists them. */
  gaps: HistoryGap[];
  /** The comparable-round universe these numbers were computed over. */
  scope: {
    settledRounds: number;
    voidedRounds: number;
    unsettledRounds: number;
  };
}

export interface HistoryGap {
  roundId: string;
  roundSlug: string;
  briefTitle: string;
  status: string;
  outcome: "voided" | "unsettled";
  reason: string | null;
  decidedAt: string;
}

/** How many recent rounds each model's panel carries. */
export const RECENT_ROUNDS_PER_MODEL = 8;

interface AnalyticsRow {
  model_id: string;
  round_id: string;
  round_slug: string;
  brief_title: string;
  outcome: ModelRoundOutcome;
  conformance: ModelConformanceRow | null;
  winner_model_id: string | null;
  fan_favorite_model_id: string | null;
  decided_at: string;
}

/**
 * Fold the per-round rows into one history per model.
 *
 * Pure and order-tolerant: it sorts by decision time itself, so the caller can
 * pass rows in any order and get a deterministic result. The two rates use
 * different denominators on purpose:
 *
 *   * **conformanceRate** is over the rounds the judge actually ruled — a void,
 *     a forfeit or an `unavailable` judge is not a "did not conform" vote, so
 *     counting it would understate the model. The denominator is the `ruled`
 *     count (conformed + not_conformed).
 *   * **crowdWinRate** is over every settled round the model was seated in,
 *     because "how often does the crowd pick it" is a share of all the chances
 *     it had, and a round with no votes is a real miss.
 *
 * Rounds that produced no result are neither rate's denominator; they are
 * carried in `voidedRounds`/`unsettledRounds` so the UI can say so.
 */
export function aggregateModelHistory(
  rows: readonly AnalyticsRow[],
  names: ReadonlyMap<string, string>,
): ModelHistory[] {
  const byModel = new Map<string, ModelHistory>();
  const ruled = new Map<string, number>();

  // Sort newest-first once, so `recent` is correct without re-sorting per model.
  const ordered = [...rows].sort(
    (a, b) => Date.parse(b.decided_at) - Date.parse(a.decided_at),
  );

  for (const row of ordered) {
    let history = byModel.get(row.model_id);
    if (!history) {
      history = {
        modelId: row.model_id,
        name: names.get(row.model_id) ?? "Unknown model",
        rounds: 0,
        settledRounds: 0,
        conformanceWins: 0,
        roundWins: 0,
        crowdWins: 0,
        forfeits: 0,
        conformanceRate: null,
        crowdWinRate: null,
        voidedRounds: 0,
        unsettledRounds: 0,
        recent: [],
      };
      byModel.set(row.model_id, history);
    }

    history.rounds += 1;

    const fact: ModelRoundFact = {
      roundId: row.round_id,
      roundSlug: row.round_slug,
      briefTitle: row.brief_title,
      outcome: row.outcome,
      conformance: row.conformance,
      winnerModelId: row.winner_model_id,
      fanFavoriteModelId: row.fan_favorite_model_id,
      decidedAt: row.decided_at,
    };
    if (history.recent.length < RECENT_ROUNDS_PER_MODEL) {
      history.recent.push(fact);
    }

    if (row.outcome === "voided") {
      history.voidedRounds += 1;
      continue;
    }
    if (row.outcome === "unsettled") {
      history.unsettledRounds += 1;
      continue;
    }

    // A settled round: the only kind either rate counts.
    history.settledRounds += 1;

    if (row.conformance === "conformed") history.conformanceWins += 1;
    if (row.conformance === "forfeited") history.forfeits += 1;
    // `unavailable` is infrastructure, not a ruling — it is neither a win nor a
    // loss and must not enter the denominator (F15: never settled on a guess).
    if (
      row.conformance === "conformed" ||
      row.conformance === "not_conformed"
    ) {
      ruled.set(row.model_id, (ruled.get(row.model_id) ?? 0) + 1);
    }

    if (row.winner_model_id === row.model_id) history.roundWins += 1;

    // The crowd vote is a round-level fact; a settled round with no votes is a
    // real miss, so the denominator is every settled round the model competed in.
    if (row.fan_favorite_model_id === row.model_id) history.crowdWins += 1;
  }

  for (const history of byModel.values()) {
    const ruledCount = ruled.get(history.modelId) ?? 0;
    history.conformanceRate =
      ruledCount > 0 ? history.conformanceWins / ruledCount : null;

    history.crowdWinRate =
      history.settledRounds > 0
        ? history.crowdWins / history.settledRounds
        : null;
  }

  // Stable, readable order: most settled rounds first, then conformance, then
  // name — never by whoever happened to be inserted first.
  return [...byModel.values()].sort(
    (a, b) =>
      b.settledRounds - a.settledRounds ||
      (b.conformanceRate ?? -1) - (a.conformanceRate ?? -1) ||
      a.name.localeCompare(b.name),
  );
}

const PAGE_SIZE = 1000;

/** Every comparable, decided round for every seated model. */
async function readAnalyticsRows(
  supabase: SupabaseClient,
): Promise<AnalyticsRow[]> {
  const rows: AnalyticsRow[] = [];
  // PostgREST caps a response at 1000 rows; page until a short page.
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("model_round_analytics")
      .select(
        "model_id, round_id, round_slug, brief_title, outcome, conformance, winner_model_id, fan_favorite_model_id, decided_at",
      )
      .order("decided_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new InternalError("Failed to read model analytics", error);
    }
    const page = (data ?? []) as unknown as AnalyticsRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function readModelNames(
  modelIds: readonly string[],
  supabase: SupabaseClient,
): Promise<Map<string, string>> {
  if (modelIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("llm_models")
    .select("id, name")
    .in("id", modelIds as string[]);

  if (error) {
    throw new InternalError("Failed to read model names", error);
  }

  return new Map(
    ((data ?? []) as Array<{ id: string; name: string }>).map((row) => [
      row.id,
      row.name,
    ]),
  );
}

interface GapRow {
  round_id: string;
  round_slug: string;
  brief_title: string;
  status: string;
  outcome: "voided" | "unsettled";
  reason: string | null;
  decided_at: string;
}

async function readGaps(
  supabase: SupabaseClient,
  limit: number,
): Promise<HistoryGap[]> {
  const { data, error } = await supabase
    .from("round_history_gaps")
    .select(
      "round_id, round_slug, brief_title, status, outcome, reason, decided_at",
    )
    .order("decided_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new InternalError("Failed to read round history gaps", error);
  }

  return ((data ?? []) as unknown as GapRow[]).map((row) => ({
    roundId: row.round_id,
    roundSlug: row.round_slug,
    briefTitle: row.brief_title,
    status: row.status,
    outcome: row.outcome,
    reason: row.reason,
    decidedAt: row.decided_at,
  }));
}

/**
 * The whole analytics read: every model's history plus the round-level gaps.
 *
 * Reads run with the service role because the page is a server component and
 * the per-round facts span every account's stakes and votes; only the derived,
 * already-public competition records leave this module.
 */
export async function getModelAnalytics(
  supabase: SupabaseClient,
): Promise<ModelAnalytics> {
  const [rows, gaps] = await Promise.all([
    readAnalyticsRows(supabase),
    readGaps(supabase, 50),
  ]);

  const modelIds = [...new Set(rows.map((row) => row.model_id))];
  const names = await readModelNames(modelIds, supabase);
  const models = aggregateModelHistory(rows, names);

  const settledRounds = new Set<string>();
  const voidedRounds = new Set<string>();
  const unsettledRounds = new Set<string>();
  for (const row of rows) {
    const bucket =
      row.outcome === "settled"
        ? settledRounds
        : row.outcome === "voided"
          ? voidedRounds
          : unsettledRounds;
    bucket.add(row.round_id);
  }

  return {
    models,
    gaps,
    scope: {
      settledRounds: settledRounds.size,
      voidedRounds: voidedRounds.size,
      unsettledRounds: unsettledRounds.size,
    },
  };
}
