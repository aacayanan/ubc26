import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { InternalError } from "@/lib/server/errors/app-error";

/**
 * F24 — user leaderboard.
 *
 * This module only READS what settlement (F18) has finalized; it never
 * computes a payout, a pot split or a fan-favorite award.
 *
 * Points: `public.user_scores.total_points` — the account balance, written
 * server-side only (clients hold no write grant), and the same number the
 * profile page shows. Accounts at 0 are not ranked. Decided 2026-11-19 over
 * ranking by the settled ledger alone. If F18 credits starter grants into
 * this column, those grants count toward rank (flagged in REQUIREMENTS.md).
 *
 * Rounds: distinct SETTLED/ARCHIVED rounds in `public.score_events`, the
 * per-round settlement ledger (unique on round_id + user_id).
 *
 * Streaks (F18, settled): a stake that settles `won` extends
 * `user_scores.current_streak`; a loss resets it to 0; a void leaves it
 * unchanged (there was no bet to lose). Fan-favorite awards do not affect
 * streaks. Settlement writes the column, so ranking can show it directly.
 *
 * Score events (F18): one `kind = 'stake'` row per participating user per
 * settled round — including 0-point losses and voids — plus a `kind =
 * 'fan_favorite'` row for crowd-vote winners. Both kinds are summed into the
 * balance, but `rounds` counts a round once even when a user has both.
 *
 * Hit rate stays pending: it needs a per-round "hit" definition wider than the
 * streak rule, which F24 owns.
 */
export const F18_STREAKS_FINAL = true;

/** Round states whose score events are final and may be ranked. */
export const SETTLED_ROUND_STATES = ["SETTLED", "ARCHIVED"] as const;

export const LEADERBOARD_LIMIT = 100;
const PAGE_SIZE = 1000;
const MAX_NAME_LENGTH = 32;

export interface SettledScoreEvent {
  userId: string;
  roundId: string;
  points: number;
}

export interface LeaderboardEntry {
  /** Opaque, stable key; never the raw user id. */
  key: string;
  /** Competition ranking: ties share a rank and the next rank skips (1,1,3). */
  rank: number;
  tied: boolean;
  displayName: string;
  /** True when displayName is a generated pseudonym, not the user's choice. */
  pseudonymous: boolean;
  points: number;
  settledRounds: number;
  /** null until F18 defines the streak rule. */
  streak: number | null;
  /** null until F18 exposes the finalized conformance outcome. */
  hitRate: number | null;
  isViewer: boolean;
}

export interface Leaderboard {
  entries: LeaderboardEntry[];
  /** Ranked accounts before truncation to LEADERBOARD_LIMIT. */
  totalRanked: number;
  pending: { streaks: boolean; hitRate: boolean };
}

const EMAIL_LIKE = /[^\s@]+@[^\s@]+/;
// Solana base58 address (32–44 chars, no 0/O/I/l). A wallet address is a
// pseudonymous identifier the user did not choose to publish here.
const WALLET_LIKE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g;

/** Opaque, deterministic key for a user. One-way; reveals nothing about the id. */
export function opaqueKey(userId: string): string {
  return createHash("sha256")
    .update(`leaderboard:${userId}`)
    .digest("hex")
    .slice(0, 12);
}

/** "Player 3F9A-C21E" — stable per account, derived from the opaque key. */
export function pseudonymFor(userId: string): string {
  const key = opaqueKey(userId).toUpperCase();
  return `Player ${key.slice(0, 4)}-${key.slice(4, 8)}`;
}

/**
 * Returns a display name that is safe to publish, or null when the stored
 * name must not be shown. F8's signup trigger falls back to the account email
 * for `display_name`, so a raw read would leak addresses; this is the guard.
 */
export function sanitizeDisplayName(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (EMAIL_LIKE.test(cleaned)) return null;
  if (WALLET_LIKE.test(cleaned)) return null;
  return cleaned.length > MAX_NAME_LENGTH
    ? `${cleaned.slice(0, MAX_NAME_LENGTH - 1)}…`
    : cleaned;
}

export interface RankInput {
  userId: string;
  displayName: string | null;
  points: number;
  settledRounds: number;
  streak: number | null;
}

/**
 * Deterministic ranking.
 *
 * Order: points desc, then the opaque key asc. The key is a stable hash, so
 * equal-point accounts always appear in the same order without favouring
 * whoever signed up first and without exposing ids. Rank is competition
 * style: every account on equal points shares the rank, and `tied` is set.
 */
export function rankEntries(
  rows: RankInput[],
  viewerId: string | null,
): LeaderboardEntry[] {
  const keyed = rows.map((row) => ({ row, key: opaqueKey(row.userId) }));
  keyed.sort((a, b) =>
    b.row.points !== a.row.points
      ? b.row.points - a.row.points
      : a.key < b.key
        ? -1
        : a.key > b.key
          ? 1
          : 0,
  );

  const counts = new Map<number, number>();
  for (const { row } of keyed) {
    counts.set(row.points, (counts.get(row.points) ?? 0) + 1);
  }

  let rank = 0;
  let previous: number | null = null;
  return keyed.map(({ row, key }, index) => {
    if (row.points !== previous) {
      rank = index + 1;
      previous = row.points;
    }
    const safeName = sanitizeDisplayName(row.displayName);
    return {
      key,
      rank,
      tied: (counts.get(row.points) ?? 0) > 1,
      displayName: safeName ?? pseudonymFor(row.userId),
      pseudonymous: safeName === null,
      points: row.points,
      settledRounds: row.settledRounds,
      streak: row.streak,
      hitRate: null,
      isViewer: viewerId !== null && row.userId === viewerId,
    };
  });
}

/**
 * Sum settled events per user. Accounts with no settled event are absent
 * (they have nothing to rank on). Malformed points are dropped rather than
 * guessed, so a bad row can never inflate a total.
 *
 * A user can have more than one event in a round — a stake return plus a
 * fan-favorite award (F18). Points from every kind are summed, but the round is
 * counted once, so "Rounds" stays a count of settled rounds rather than events.
 */
export function aggregateSettled(
  events: SettledScoreEvent[],
): Map<string, { points: number; rounds: Set<string> }> {
  const totals = new Map<string, { points: number; rounds: Set<string> }>();
  for (const event of events) {
    if (!Number.isInteger(event.points) || event.points < 0) continue;
    const current = totals.get(event.userId) ?? {
      points: 0,
      rounds: new Set<string>(),
    };
    // Every kind counts toward points; the set de-dups the round count.
    current.points += event.points;
    current.rounds.add(event.roundId);
    totals.set(event.userId, current);
  }
  return totals;
}

interface ScoreEventRow {
  user_id: string;
  round_id: string;
  points: number;
}

async function readSettledEvents(
  supabase: SupabaseClient,
): Promise<SettledScoreEvent[]> {
  const events: SettledScoreEvent[] = [];
  // PostgREST caps a response at 1000 rows; page until a short page.
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("score_events")
      .select("user_id, round_id, points, rounds!inner(status)")
      .in("rounds.status", [...SETTLED_ROUND_STATES])
      .order("id")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new InternalError("Failed to load settled scores", error);
    }
    const rows = (data ?? []) as unknown as ScoreEventRow[];
    for (const row of rows) {
      events.push({
        userId: row.user_id,
        roundId: row.round_id,
        points: row.points,
      });
    }
    if (rows.length < PAGE_SIZE) return events;
  }
}

export interface ScoreBalance {
  userId: string;
  points: number;
  streak: number;
}

interface UserScoreRow {
  user_id: string;
  total_points: number;
  current_streak: number;
}

/** Accounts with a positive balance. Malformed balances are skipped. */
async function readBalances(supabase: SupabaseClient): Promise<ScoreBalance[]> {
  const balances: ScoreBalance[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("user_scores")
      .select("user_id, total_points, current_streak")
      .gt("total_points", 0)
      .order("user_id")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new InternalError("Failed to load points balances", error);
    }
    const rows = (data ?? []) as UserScoreRow[];
    for (const row of rows) {
      if (!Number.isInteger(row.total_points) || row.total_points <= 0) {
        continue;
      }
      balances.push({
        userId: row.user_id,
        points: row.total_points,
        streak: row.current_streak ?? 0,
      });
    }
    if (rows.length < PAGE_SIZE) return balances;
  }
}

export async function getLeaderboard(
  supabase: SupabaseClient,
  viewerId: string | null,
): Promise<Leaderboard> {
  const pending = { streaks: !F18_STREAKS_FINAL, hitRate: true };
  const balances = await readBalances(supabase);

  if (balances.length === 0) {
    return { entries: [], totalRanked: 0, pending };
  }

  const settled = aggregateSettled(await readSettledEvents(supabase));
  const userIds = balances.map((balance) => balance.userId);
  const names = new Map<string, string | null>();

  for (let i = 0; i < userIds.length; i += PAGE_SIZE) {
    const batch = userIds.slice(i, i + PAGE_SIZE);
    // Only the display name is read — never role, avatar or wallet.
    const { data, error } = await supabase
      .from("users")
      .select("id, display_name")
      .in("id", batch);
    if (error) {
      throw new InternalError("Failed to load leaderboard accounts", error);
    }
    for (const row of (data ?? []) as Array<{
      id: string;
      display_name: string | null;
    }>) {
      names.set(row.id, row.display_name);
    }
  }

  const ranked = rankEntries(
    balances.map((balance) => ({
      userId: balance.userId,
      // A missing profile row reads as no name -> pseudonym, not an error.
      displayName: names.get(balance.userId) ?? null,
      points: balance.points,
      settledRounds: settled.get(balance.userId)?.rounds.size ?? 0,
      streak: F18_STREAKS_FINAL ? balance.streak : null,
    })),
    viewerId,
  );

  const top = ranked.slice(0, LEADERBOARD_LIMIT);
  // Keep the viewer's own row visible even when they rank outside the top.
  const viewerRow = ranked.find((entry) => entry.isViewer);
  if (viewerRow && !top.includes(viewerRow)) top.push(viewerRow);

  return { entries: top, totalRanked: ranked.length, pending };
}
