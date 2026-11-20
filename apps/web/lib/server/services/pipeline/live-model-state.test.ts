import { describe, expect, it } from "vitest";
import type { LLMFailureKind } from "@ai-showdown/shared";

import {
  deriveFailure,
  deriveModelState,
  isInfrastructureFailure,
  type LiveModelFacts,
} from "./live-model-state";

/**
 * F27: what the live view is allowed to say.
 *
 * These pin the three things a live page must not get wrong — the state comes
 * from persisted rows, a retryable outage is not a forfeit, and a failure is
 * explained in our words rather than the provider's.
 */

const base: LiveModelFacts = {
  executionStatus: null,
  failureKind: null,
  artifactStored: false,
  artifactGatePassed: null,
  artifactUnavailable: false,
  judgeRuled: false,
  judgeVerdict: null,
};

const facts = (patch: Partial<LiveModelFacts>): LiveModelFacts => ({
  ...base,
  ...patch,
});

describe("deriveModelState", () => {
  it("is pending before the execution row exists", () => {
    expect(deriveModelState(base)).toBe("pending");
    expect(deriveModelState(facts({ executionStatus: "pending" }))).toBe(
      "pending",
    );
  });

  it("is generating while the model is still writing", () => {
    expect(deriveModelState(facts({ executionStatus: "running" }))).toBe(
      "generating",
    );
  });

  it("is rendering when generation finished and no artifact exists yet", () => {
    // The state the previous derivation could never reach: the full render is
    // being drawn, and nothing has been gated or judged.
    expect(deriveModelState(facts({ executionStatus: "succeeded" }))).toBe(
      "rendering",
    );
  });

  it("is judging once a gate-passing artifact is stored but no ruling exists", () => {
    expect(
      deriveModelState(
        facts({
          executionStatus: "succeeded",
          artifactStored: true,
          artifactGatePassed: true,
        }),
      ),
    ).toBe("judging");
  });

  it("is forfeited when the stored artifact failed the gate", () => {
    // F14/F17 never judge a gate failure. Before this branch existed the model
    // sat on "judging" forever — a rendered-on-flat-colour render and a
    // render-that-threw both waited for a ruling that could never arrive.
    expect(
      deriveModelState(
        facts({
          executionStatus: "succeeded",
          artifactStored: true,
          artifactGatePassed: false,
        }),
      ),
    ).toBe("forfeited");
  });

  it("reports the stored ruling once the judge has spoken", () => {
    expect(
      deriveModelState(
        facts({
          executionStatus: "succeeded",
          artifactStored: true,
          judgeRuled: true,
          judgeVerdict: "conformed",
        }),
      ),
    ).toBe("conformed");
    expect(
      deriveModelState(
        facts({ judgeRuled: true, judgeVerdict: "not_conformed" }),
      ),
    ).toBe("not_conformed");
  });

  it("treats a failed generation as a forfeit", () => {
    expect(
      deriveModelState(
        facts({ executionStatus: "timeout", failureKind: "timeout" }),
      ),
    ).toBe("forfeited");
    expect(
      deriveModelState(
        facts({ executionStatus: "error", failureKind: "provider_error" }),
      ),
    ).toBe("forfeited");
  });

  it("treats a provider outage as unavailable, not a forfeit", () => {
    expect(
      deriveModelState(
        facts({ executionStatus: "unavailable", failureKind: "network" }),
      ),
    ).toBe("unavailable");
  });

  it("treats an unavailable sandbox as unavailable even after a clean generation", () => {
    // The model wrote a valid source; Docker never ran. Blaming the model here
    // would be the "forfeit silently becomes last place" mistake (rule #9).
    expect(
      deriveModelState(
        facts({ executionStatus: "succeeded", artifactUnavailable: true }),
      ),
    ).toBe("unavailable");
  });
});

describe("deriveFailure", () => {
  it("explains nothing while a model is healthy", () => {
    expect(deriveFailure(base)).toBeNull();
    expect(deriveFailure(facts({ executionStatus: "running" }))).toBeNull();
    expect(deriveFailure(facts({ executionStatus: "succeeded" }))).toBeNull();
  });

  it("explains nothing for a ruled model", () => {
    expect(
      deriveFailure(
        facts({
          executionStatus: "succeeded",
          artifactStored: true,
          judgeRuled: true,
          judgeVerdict: "conformed",
        }),
      ),
    ).toBeNull();
  });

  it("explains a generation failure in viewer language", () => {
    const failure = deriveFailure(
      facts({ executionStatus: "error", failureKind: "rate_limited" }),
    );
    expect(failure?.stage).toBe("generation");
    expect(failure?.message).toMatch(/rate-limited/);
  });

  it("explains a sandbox outage as a retry, not a forfeit", () => {
    const failure = deriveFailure(
      facts({ executionStatus: "succeeded", artifactUnavailable: true }),
    );
    expect(failure?.stage).toBe("render");
    expect(failure?.message).toMatch(/retried/);
  });

  it("never echoes provider text for any known failure class", () => {
    const kinds: LLMFailureKind[] = [
      "timeout",
      "network",
      "rate_limited",
      "provider_error",
      "model_unavailable",
      "auth",
      "insufficient_credits",
      "invalid_request",
      "malformed_response",
    ];

    for (const kind of kinds) {
      const failure = deriveFailure(
        facts({ executionStatus: "error", failureKind: kind }),
      );
      expect(failure).not.toBeNull();
      // A provider message would carry a URL, a key hint or a status line; our
      // copy never does.
      expect(failure!.message).not.toMatch(/https?:|sk-|api[_-]?key/i);
      expect(failure!.message.length).toBeGreaterThan(10);
    }
  });

  it("still says something safe for an unrecognised failure class", () => {
    const failure = deriveFailure(
      facts({ executionStatus: "error", failureKind: "something-new" }),
    );
    expect(failure?.message).toMatch(/generation failed/);
  });
});

describe("isInfrastructureFailure", () => {
  it("separates provider outages from model mistakes", () => {
    expect(isInfrastructureFailure("network")).toBe(true);
    expect(isInfrastructureFailure("rate_limited")).toBe(true);
    expect(isInfrastructureFailure("provider_error")).toBe(false);
    expect(isInfrastructureFailure("malformed_response")).toBe(false);
    expect(isInfrastructureFailure(null)).toBe(false);
  });
});
