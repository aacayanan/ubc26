import assert from "node:assert/strict";
import { test } from "vitest";

import { ConflictError } from "@/lib/server/errors/app-error";
import {
  assertRoundTransition,
  canTransitionRound,
  isFinalRoundStatus,
  transitionCompetitionRound,
  type RoundTransitionRepository,
} from "./round-state-machine";

test("allows the normal lifecycle", () => {
  const normal = [
    ["CREATED", "OPEN"],
    ["OPEN", "LOCKED"],
    ["LOCKED", "RUNNING"],
    ["RUNNING", "EVALUATING"],
    ["EVALUATING", "SETTLED"],
    ["SETTLED", "ARCHIVED"],
  ] as const;

  for (const [from, to] of normal) {
    assert.equal(canTransitionRound(from, to), true);
  }
});

test("rejects an invalid jump", () => {
  assert.equal(canTransitionRound("OPEN", "SETTLED"), false);
  assert.throws(
    () => assertRoundTransition("OPEN", "SETTLED"),
    (error) =>
      error instanceof ConflictError &&
      error.message === "Invalid round status transition: OPEN -> SETTLED",
  );
});

test("allows failure and retry transitions", () => {
  assert.equal(canTransitionRound("RUNNING", "FAILED"), true);
  assert.equal(canTransitionRound("FAILED", "RETRYING"), true);
  assert.equal(canTransitionRound("RETRYING", "EVALUATING"), true);
});

test("allows cancellation from cancellable states", () => {
  assert.equal(canTransitionRound("CREATED", "CANCELLED"), true);
  assert.equal(canTransitionRound("OPEN", "CANCELLED"), true);
  assert.equal(canTransitionRound("LOCKED", "CANCELLED"), true);
  assert.equal(canTransitionRound("RUNNING", "CANCELLED"), true);
  assert.equal(canTransitionRound("FAILED", "CANCELLED"), true);
  assert.equal(canTransitionRound("RETRYING", "CANCELLED"), true);
  assert.equal(canTransitionRound("SETTLED", "CANCELLED"), false);
});

test("a repeated transition is safe and does not write", async () => {
  let writes = 0;
  const repository: RoundTransitionRepository = {
    getRoundStatus: async () => "OPEN",
    transitionRound: async () => {
      writes += 1;
      return "OPEN";
    },
  };

  const result = await transitionCompetitionRound(repository, {
    roundId: "round-1",
    to: "OPEN",
  });

  assert.equal(result, "OPEN");
  assert.equal(writes, 0);
});

test("the service passes the expected status for a compare-and-set retry", async () => {
  let receivedExpectedStatus: string | undefined;
  const repository: RoundTransitionRepository = {
    getRoundStatus: async () => "LOCKED",
    transitionRound: async (request) => {
      receivedExpectedStatus = request.expectedStatus;
      return "RUNNING";
    },
  };

  const result = await transitionCompetitionRound(repository, {
    roundId: "round-1",
    to: "RUNNING",
  });

  assert.equal(receivedExpectedStatus, "LOCKED");
  assert.equal(result, "RUNNING");
});

test("settled, voided, and archived rounds are finalized", () => {
  assert.equal(isFinalRoundStatus("SETTLED"), true);
  assert.equal(isFinalRoundStatus("VOIDED"), true);
  assert.equal(isFinalRoundStatus("ARCHIVED"), true);
  assert.equal(canTransitionRound("ARCHIVED", "OPEN"), false);
  assert.equal(canTransitionRound("SETTLED", "CANCELLED"), false);
});
