import "server-only";

import type { RoundStatus } from "@ai-showdown/shared";
import { ConflictError, NotFoundError } from "@/lib/server/errors/app-error";

export const FINAL_ROUND_STATUSES: readonly RoundStatus[] = [
  "SETTLED",
  "VOIDED",
  "ARCHIVED",
];

export const ROUND_TRANSITIONS: Readonly<
  Record<RoundStatus, readonly RoundStatus[]>
> = {
  CREATED: ["OPEN", "CANCELLED"],
  OPEN: ["LOCKED", "CANCELLED"],
  LOCKED: ["RUNNING", "CANCELLED"],
  RUNNING: ["EVALUATING", "FAILED", "CANCELLED"],
  EVALUATING: ["SETTLED", "VOIDED", "FAILED", "RETRYING"],
  SETTLED: ["ARCHIVED"],
  ARCHIVED: [],
  CANCELLED: [],
  FAILED: ["RETRYING", "CANCELLED"],
  RETRYING: ["EVALUATING", "FAILED", "CANCELLED"],
  VOIDED: ["ARCHIVED"],
};

export function canTransitionRound(
  from: RoundStatus,
  to: RoundStatus,
): boolean {
  return from === to ? true : ROUND_TRANSITIONS[from].includes(to);
}

export function assertRoundTransition(
  from: RoundStatus,
  to: RoundStatus,
): void {
  if (!canTransitionRound(from, to)) {
    throw new ConflictError(
      `Invalid round status transition: ${from} -> ${to}`,
    );
  }
}

export function isFinalRoundStatus(status: RoundStatus): boolean {
  return FINAL_ROUND_STATUSES.includes(status);
}

export interface RoundTransitionRequest {
  roundId: string;
  to: RoundStatus;
  reason?: string;
  actorId?: string;
}

export interface RoundTransitionRepository {
  getRoundStatus(roundId: string): Promise<RoundStatus | null>;
  transitionRound(
    request: RoundTransitionRequest & { expectedStatus: RoundStatus },
  ): Promise<RoundStatus>;
}

export async function transitionCompetitionRound(
  repository: RoundTransitionRepository,
  request: RoundTransitionRequest,
): Promise<RoundStatus> {
  const currentStatus = await repository.getRoundStatus(request.roundId);

  if (!currentStatus) {
    throw new NotFoundError("Competition round not found");
  }

  assertRoundTransition(currentStatus, request.to);

  if (currentStatus === request.to) {
    return currentStatus;
  }

  const transitioned = await repository.transitionRound({
    ...request,
    expectedStatus: currentStatus,
  });

  assertRoundTransition(currentStatus, transitioned);
  return transitioned;
}
