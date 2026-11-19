import assert from "node:assert/strict";
import test from "node:test";

import { isActiveCompetition } from "./active-competitions";

test("OPEN rounds with a future deadline are active", () => {
  assert.equal(
    isActiveCompetition(
      {
        status: "OPEN",
        prediction_opens_at: "2026-11-19T00:00:00Z",
        prediction_deadline: "2026-11-20T00:00:00Z",
      },
      new Date("2026-11-19T12:00:00Z"),
    ),
    true,
  );
});

test("past or future-opening rounds are not active", () => {
  const now = new Date("2026-11-19T12:00:00Z");

  assert.equal(
    isActiveCompetition(
      {
        status: "OPEN",
        prediction_opens_at: "2026-11-19T00:00:00Z",
        prediction_deadline: "2026-11-19T11:00:00Z",
      },
      now,
    ),
    false,
  );
  assert.equal(
    isActiveCompetition(
      {
        status: "OPEN",
        prediction_opens_at: "2026-11-19T13:00:00Z",
        prediction_deadline: "2026-11-20T00:00:00Z",
      },
      now,
    ),
    false,
  );
});

test("only OPEN rounds are active", () => {
  assert.equal(
    isActiveCompetition(
      {
        status: "LOCKED",
        prediction_opens_at: "2026-11-19T00:00:00Z",
        prediction_deadline: "2026-11-20T00:00:00Z",
      },
      new Date("2026-11-19T12:00:00Z"),
    ),
    false,
  );
});
