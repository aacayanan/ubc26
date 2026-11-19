import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { ValidationError } from "@/lib/server/errors/app-error";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { getRoundResult } from "@/lib/server/services/results/results";

/**
 * One round's full result: GET /api/results/[id] (F19).
 *
 * Public — everything here is either public record or, once the round is past
 * OPEN, already-revealed render data. The one viewer-scoped field is
 * `viewer_stake`, present only when a session exists and the viewer staked. The
 * two-clocks rule is enforced in the service (`isRevealed`), so code and frames
 * are blank for a round that has not locked.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiErrorHandling(request, async () => {
    const { id } = await context.params;

    if (!UUID_PATTERN.test(id)) {
      throw new ValidationError("Round id must be a UUID");
    }

    const user = await getAuthenticatedUser();
    const result = await getRoundResult(id, user?.id ?? null);

    return Response.json(
      {
        result: {
          round_id: result.roundId,
          slug: result.slug,
          brief_title: result.briefTitle,
          brief_prompt: result.briefPrompt,
          status: result.status,
          revealed: result.revealed,
          display_state: result.displayState,
          replay: {
            entry_point: result.replay.entryPoint,
            frame_width: result.replay.frameWidth,
            frame_height: result.replay.frameHeight,
            target_duration_ms: result.replay.targetDurationMs,
            frame_count: result.replay.frameCount,
          },
          outcome: result.outcome
            ? {
                kind: result.outcome.kind,
                winner_model_id: result.outcome.winnerModelId,
                fan_favorite_model_id: result.outcome.fanFavoriteModelId,
                tie_break: result.outcome.tieBreak,
                reason: result.outcome.reason,
                all_forfeited: result.outcome.allForfeited,
              }
            : null,
          pool: {
            pot_points: result.pool.potPoints,
            models: result.pool.models.map((m) => ({
              model_id: m.modelId,
              name: m.name,
              staked: m.staked,
              multiplier: m.multiplier,
              share: m.share,
            })),
          },
          crowd: result.crowd
            ? { counts: result.crowd.counts, award_points: result.crowd.awardPoints }
            : null,
          models: result.models.map((m) => ({
            model_id: m.modelId,
            name: m.name,
            ordinal: m.ordinal,
            status: m.status,
            forfeit_reason: m.forfeitReason,
            gate: m.gate,
            judge: m.judge,
            frames: m.frames,
            solution_code: m.solutionCode,
            staked: m.staked,
            multiplier: m.multiplier,
            share: m.share,
            is_winner: m.isWinner,
            is_fan_favorite: m.isFanFavorite,
          })),
          viewer_stake: result.viewerStake
            ? {
                model_id: result.viewerStake.modelId,
                points: result.viewerStake.points,
                outcome: result.viewerStake.outcome,
                awarded: result.viewerStake.awarded,
              }
            : null,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
