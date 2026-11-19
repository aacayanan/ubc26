import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ConflictError,
  InternalError,
  ValidationError,
} from "@/lib/server/errors/app-error";
import type { CrowdVoteTally } from "@/lib/server/services/evaluation/outcome";

/**
 * The crowd vote as settlement consumes it (F18; the full surface is F32).
 *
 * Settlement needs two things from the vote and nothing else: a per-model tally
 * to break equal conformance, and the list of (user, pick) pairs so the
 * fan-favorite award can pay everyone who backed the crowd's winner. Both are
 * read here so `outcome.ts` stays pure and the vote table stays in one place.
 *
 * The two clocks are enforced in the database (`ensure_vote_allowed`), not here:
 * a vote is only legal once the round has locked, so no vote can influence a
 * stake that was placed against the same outcome.
 */

export interface CastVoteInput {
  roundId: string;
  modelId: string;
  /** User-scoped: the RPC attributes the vote with `auth.uid()`. */
  supabase: SupabaseClient;
}

export interface CastVoteResult {
  voteId: string;
  roundId: string;
  modelId: string;
}

export async function castVote(input: CastVoteInput): Promise<CastVoteResult> {
  const { roundId, modelId, supabase } = input;

  const { data, error } = await supabase.rpc("cast_vote", {
    p_round_id: roundId,
    p_model_id: modelId,
  });

  if (error) {
    throw mapVoteError(error, { roundId, modelId });
  }

  const row = Array.isArray(data)
    ? (data[0] as
        | { vote_id: string; vote_round_id: string; vote_model_id: string }
        | undefined)
    : undefined;

  if (!row) {
    throw new InternalError("The vote was not recorded", { roundId });
  }

  return {
    voteId: row.vote_id,
    roundId: row.vote_round_id,
    modelId: row.vote_model_id,
  };
}

export interface StoredVote {
  userId: string;
  modelId: string;
}

/** Every vote on a round, newest last. Read with the service role. */
export async function listVotes(
  roundId: string,
  supabase: SupabaseClient,
): Promise<StoredVote[]> {
  const { data, error } = await supabase
    .from("round_votes")
    .select("user_id, model_id")
    .eq("round_id", roundId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new InternalError("Failed to read the crowd vote", error);
  }

  return ((data ?? []) as Array<{ user_id: string; model_id: string }>).map(
    (row) => ({ userId: row.user_id, modelId: row.model_id }),
  );
}

/** The tally `resolveRoundOutcome` takes, plus the raw votes for the award. */
export async function getCrowdVote(
  roundId: string,
  supabase: SupabaseClient,
): Promise<{ tally: CrowdVoteTally; votes: StoredVote[] }> {
  const votes = await listVotes(roundId, supabase);

  const counts: Record<string, number> = {};
  for (const vote of votes) {
    counts[vote.modelId] = (counts[vote.modelId] ?? 0) + 1;
  }

  return { tally: { counts }, votes };
}

function mapVoteError(
  error: { code?: string; message?: string },
  context: Record<string, unknown>,
): Error {
  const message = error.message ?? "Failed to cast the vote";

  switch (error.code) {
    case "42501":
      return new ConflictError(message);
    case "P0001":
      // The vote window is not open for this round yet, or has closed.
      return new ConflictError(message);
    case "22023":
      return new ValidationError(message);
    default:
      return new InternalError("Failed to cast the vote", {
        ...context,
        error,
      });
  }
}
