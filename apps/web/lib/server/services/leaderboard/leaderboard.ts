import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { InternalError } from "@/lib/server/errors/app-error";

/**
 * F24 — user leaderboard, ranked on Devnet SOL predictions.
 *
 * The points pool is retired (2026-11-20). A prediction is an accepted
 * `public.wagers` row; it is *correct* when SOL settlement marked it `won`
 * and *incorrect* when it marked it `lost`. Refunded wagers (void rounds,
 * rejected transfers) are neither and do not count.
 *
 * Rank: correct predictions desc, then a stable opaque key. Accounts with no decided prediction are not
 * ranked. Wagers are owner-only under RLS, so callers pass a service-role
 * client; only tallies and sanitized names leave this module.
 */

export const LEADERBOARD_LIMIT = 100;
const PAGE_SIZE = 1000;
const MAX_NAME_LENGTH = 32;

export interface DecidedPrediction {
  userId: string;
  correct: boolean;
}

export interface PredictionTally {
  correct: number;
  /** Settled won + lost predictions. */
  decided: number;
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
  correctPredictions: number;
  decidedPredictions: number;
  isViewer: boolean;
}

export interface Leaderboard {
  entries: LeaderboardEntry[];
  /** Ranked accounts before truncation to LEADERBOARD_LIMIT. */
  totalRanked: number;
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

export interface RankInput extends PredictionTally {
  userId: string;
  displayName: string | null;
}

/**
 * Deterministic ranking: correct desc, opaque key asc. Rank is competition
 * style — accounts with equal correct predictions share it.
 */
export function rankEntries(
  rows: RankInput[],
  viewerId: string | null,
): LeaderboardEntry[] {
  const keyed = rows.map((row) => ({ row, key: opaqueKey(row.userId) }));
  keyed.sort((a, b) =>
    b.row.correct !== a.row.correct
      ? b.row.correct - a.row.correct
      : a.key < b.key
        ? -1
        : a.key > b.key
          ? 1
          : 0,
  );

  const counts = new Map<number, number>();
  for (const { row } of keyed) {
    counts.set(row.correct, (counts.get(row.correct) ?? 0) + 1);
  }

  let rank = 0;
  let previous: number | null = null;
  return keyed.map(({ row, key }, index) => {
    if (row.correct !== previous) {
      rank = index + 1;
      previous = row.correct;
    }
    const safeName = sanitizeDisplayName(row.displayName);
    return {
      key,
      rank,
      tied: (counts.get(row.correct) ?? 0) > 1,
      displayName: safeName ?? pseudonymFor(row.userId),
      pseudonymous: safeName === null,
      correctPredictions: row.correct,
      decidedPredictions: row.decided,
      isViewer: viewerId !== null && row.userId === viewerId,
    };
  });
}

/** Tally decided predictions per user. */
export function aggregatePredictions(
  predictions: DecidedPrediction[],
): Map<string, PredictionTally> {
  const totals = new Map<string, PredictionTally>();
  for (const prediction of predictions) {
    const current = totals.get(prediction.userId) ?? { correct: 0, decided: 0 };
    current.decided += 1;
    if (prediction.correct) current.correct += 1;
    totals.set(prediction.userId, current);
  }
  return totals;
}

interface WagerRow {
  user_id: string;
  settlement_outcome: string | null;
}

/** Every accepted wager that settled won or lost, optionally for one user. */
export async function readDecidedPredictions(
  supabase: SupabaseClient,
  userId?: string,
): Promise<DecidedPrediction[]> {
  const out: DecidedPrediction[] = [];
  // PostgREST caps a response at 1000 rows; page until a short page.
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from("wagers")
      .select("user_id, settlement_outcome")
      .eq("status", "accepted")
      .in("settlement_outcome", ["won", "lost"]);
    if (userId) query = query.eq("user_id", userId);
    const { data, error } = await query
      .order("id")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new InternalError("Failed to load settled predictions", error);
    }
    const rows = (data ?? []) as WagerRow[];
    for (const row of rows) {
      out.push({
        userId: row.user_id,
        correct: row.settlement_outcome === "won",
      });
    }
    if (rows.length < PAGE_SIZE) return out;
  }
}

export async function getLeaderboard(
  supabase: SupabaseClient,
  viewerId: string | null,
): Promise<Leaderboard> {
  const totals = aggregatePredictions(await readDecidedPredictions(supabase));
  if (totals.size === 0) return { entries: [], totalRanked: 0 };

  const userIds = [...totals.keys()];
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
    userIds.map((userId) => ({
      userId,
      // A missing profile row reads as no name -> pseudonym, not an error.
      displayName: names.get(userId) ?? null,
      ...totals.get(userId)!,
    })),
    viewerId,
  );

  const top = ranked.slice(0, LEADERBOARD_LIMIT);
  // Keep the viewer's own row visible even when they rank outside the top.
  const viewerRow = ranked.find((entry) => entry.isViewer);
  if (viewerRow && !top.includes(viewerRow)) top.push(viewerRow);

  return { entries: top, totalRanked: ranked.length };
}
