import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ConflictError,
  InternalError,
  ValidationError,
} from "@/lib/server/errors/app-error";

/**
 * Stakes (F18, with F10's join gate).
 *
 * `public.place_stake` is the only write path: it reads the round's clock, the
 * model's participation, the caller's `funded`/`practice_mode` flags and the
 * score row under a lock, none of which a client is granted. This module is the
 * thin typed wrapper — it validates the shape the RPC cannot see (a string that
 * should be a UUID) and maps Postgres error codes onto the app's error types so
 * the route returns 400/409/403 rather than a generic 500.
 */

/** The smallest stake `place_stake` accepts (point-denominated, no money). */
export const MIN_STAKE_POINTS = 10;

export interface PlaceStakeInput {
  roundId: string;
  modelId: string;
  points: number;
  commitmentHash?: string | null;
  /**
   * A user-scoped client. The RPC identifies the caller with `auth.uid()`, so
   * passing the service-role client here would place the stake for *nobody*.
   */
  supabase: SupabaseClient;
}

export interface PlacedStake {
  predictionId: string;
  roundId: string;
  modelId: string;
  stakePoints: number;
  /** Every open stake the account now holds, this one included. */
  reservedPoints: number;
  /** The settled balance at stake time — unchanged by this call. */
  balance: number;
}

interface PlaceStakeRow {
  prediction_id: string;
  // Renamed from round_id/model_id to avoid 42702 (ambiguous column) against
  // the function's own table references — see 20261119000800.
  stake_round_id: string;
  stake_model_id: string;
  stake_points: number;
  reserved_points: number;
  balance: number;
}

export async function placeStake(input: PlaceStakeInput): Promise<PlacedStake> {
  const { roundId, modelId, points, commitmentHash, supabase } = input;

  if (!Number.isInteger(points) || points < MIN_STAKE_POINTS) {
    throw new ValidationError(
      `A stake must be a whole number of at least ${MIN_STAKE_POINTS} points`,
      { points },
    );
  }

  const { data, error } = await supabase.rpc("place_stake", {
    p_round_id: roundId,
    p_model_id: modelId,
    p_points: points,
    p_commitment_hash: commitmentHash ?? null,
  });

  if (error) {
    throw mapStakeError(error, { roundId, points });
  }

  const row = Array.isArray(data)
    ? (data[0] as PlaceStakeRow | undefined)
    : undefined;

  if (!row) {
    throw new InternalError("The stake was not recorded", { roundId });
  }

  return {
    predictionId: row.prediction_id,
    roundId: row.stake_round_id,
    modelId: row.stake_model_id,
    stakePoints: row.stake_points,
    reservedPoints: row.reserved_points,
    balance: row.balance,
  };
}

/**
 * Map the RPC's SQLSTATEs onto HTTP-meaningful errors.
 *
 * `place_stake` raises deliberately: `42501` is the join gate, `P0001` is a
 * closed window, `22023`/`22003` are bad input and over-balance. Everything else
 * is unexpected and becomes a 500 rather than a message we might have guessed
 * wrong.
 */
function mapStakeError(
  error: { code?: string; message?: string },
  context: Record<string, unknown>,
): Error {
  const message = error.message ?? "Failed to place the stake";

  switch (error.code) {
    case "42501":
      // Not funded, in practice mode, or not signed in.
      return new ConflictError(message);
    case "P0001":
      // Round no longer OPEN, or the deadline has passed.
      return new ConflictError(message);
    case "22023":
    case "22003":
      return new ValidationError(message);
    default:
      return new InternalError("Failed to place the stake", {
        ...context,
        error,
      });
  }
}

export interface RoundStakeSummary {
  /** Sum of every conformance stake on the round — the pot as it stands. */
  potPoints: number;
  stakesByModel: Record<string, number>;
}

/**
 * The live pot for a round, read through the service role.
 *
 * Public reads of `predictions` are own-rows-only, so a viewer cannot total the
 * pool themselves — the round page gets this number from the server instead.
 * Only settled_status "open" stakes count: a settled row is a past round's record.
 */
export async function getRoundStakeSummary(
  roundId: string,
  supabase: SupabaseClient,
): Promise<RoundStakeSummary> {
  const { data, error } = await supabase
    .from("predictions")
    .select("model_id, stake_points")
    .eq("round_id", roundId)
    .eq("category", "conformance");

  if (error) {
    throw new InternalError("Failed to read the round's pool", error);
  }

  const stakesByModel: Record<string, number> = {};
  let potPoints = 0;

  for (const row of (data ?? []) as Array<{
    model_id: string;
    stake_points: number | null;
  }>) {
    const points = row.stake_points ?? 0;
    if (!Number.isInteger(points) || points <= 0) continue;
    stakesByModel[row.model_id] = (stakesByModel[row.model_id] ?? 0) + points;
    potPoints += points;
  }

  return { potPoints, stakesByModel };
}
