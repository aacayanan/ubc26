import type {
  ExecutionStatus,
  LiveFailure,
  LiveModelState,
  LLMFailureKind,
} from "@ai-showdown/shared";

/**
 * Turning persisted pipeline facts into what a viewer sees (F27).
 *
 * The progress endpoint reads rows; this module decides what they *mean*. It is
 * pure and free of I/O for the same reason `results/display.ts` is: the rules a
 * live view must not get wrong are testable without a database, and the service
 * that owns the queries stays a plain read.
 *
 * Three rules this exists to keep:
 *
 *   * **State is derived from what was persisted, never from an assumption.**
 *     A model is `rendering` because generation finished and no artifact row
 *     exists yet — not because a timer says so. A refresh therefore recovers the
 *     truth instead of restarting a guess (F27 acceptance #1–#2).
 *   * **A failure is explained, not leaked.** `model_executions.error_message`
 *     is whatever OpenRouter said, and a live page is public. Every message here
 *     is written for a viewer and keyed on the coarse class, never echoed
 *     (F27 acceptance #3).
 *   * **The live view agrees with the final verdict.** A generation failure is a
 *     forfeit here because `finishOneModel` folds it into a failed gate, which
 *     F15 settles as `forfeited`. An outage that stopped the sandbox is
 *     `unavailable`, which F15 treats as retryable rather than a guess.
 */

/** The persisted facts one model contributes to the live view. */
export interface LiveModelFacts {
  /** `model_executions.status` for the generation run, or null before it starts. */
  executionStatus: ExecutionStatus | null;
  /** `model_executions.failure_kind`, when the run recorded one. */
  failureKind: string | null;
  /** True when a `rendered_artifacts` row exists for this execution. */
  artifactStored: boolean;
  /**
   * The stored artifact's gate verdict (F14), or null when none is stored.
   * A rendered model that failed the gate is never judged (non-negotiable #9),
   * so without this fact it would display "judging" forever, waiting for a
   * ruling that is never coming.
   */
  artifactGatePassed: boolean | null;
  /** True when the artifact row records an infrastructure outage, not a verdict. */
  artifactUnavailable: boolean;
  /** True when a judge ruling is stored for this model. */
  judgeRuled: boolean;
  /** The judge's verdict, when one is stored. */
  judgeVerdict: "conformed" | "not_conformed" | "unavailable" | null;
}

/**
 * Where this model is in the pipeline.
 *
 * Order is load-bearing, and mirrors `classifyModelOutcome` in
 * `evaluation/outcome.ts` so the live view and the final verdict cannot tell
 * two different stories:
 *
 *   1. a stored ruling is the answer — the judge has spoken;
 *   2. an infrastructure outage is `unavailable`, never a forfeit;
 *   3. a failed generation is `forfeited` — it never produced a source;
 *   4. generation finished with no artifact yet is `rendering` — this is the
 *      state that was previously unreachable, and the one that matters most on
 *      screen, because it is when the full render is actually being drawn;
 *   5. a stored artifact that failed the gate is `forfeited` — F14/F17 never
 *      judge it, so calling it `judging` would wait on a ruling that never
 *      arrives (this is the branch that used to strand a round in "judging");
 *   6. generation finished with a gate-passing artifact is `judging` — waiting
 *      on a ruling.
 */
export function deriveModelState(facts: LiveModelFacts): LiveModelState {
  if (facts.judgeRuled && facts.judgeVerdict) {
    return facts.judgeVerdict;
  }

  const status = facts.executionStatus;

  if (status === null || status === "pending") return "pending";
  if (status === "running") return "generating";

  // A render sandbox that never ran is infrastructure (F15): the round is
  // retryable, so the model is not disqualified.
  if (facts.artifactUnavailable || status === "unavailable")
    return "unavailable";

  if (status === "timeout" || status === "error") return "forfeited";

  if (status === "succeeded") {
    if (!facts.artifactStored) return "rendering";
    // Rendered but failed the gate: a forfeit, not a model awaiting a ruling.
    // F14/F17 never judge a gate failure, so "judging" here would never resolve.
    if (facts.artifactGatePassed === false) return "forfeited";
    return "judging";
  }

  return "generating";
}

/** Coarse classes that mean the provider failed us, not the model. */
const INFRASTRUCTURE_FAILURES: ReadonlySet<string> = new Set<LLMFailureKind>([
  "timeout",
  "network",
  "rate_limited",
  "model_unavailable",
  "auth",
  "insufficient_credits",
]);

/** Failure copy per class. Every string is viewer-facing; none quotes a provider. */
const PROVIDER_MESSAGES: Record<string, string> = {
  timeout: "The model's provider stopped responding.",
  network: "The model's provider could not be reached.",
  rate_limited: "The provider rate-limited this model, so it could not finish.",
  provider_error:
    "The provider returned an error while this model was writing.",
  model_unavailable: "This model is no longer available from the provider.",
  auth: "The provider rejected the request, so this model could not run.",
  insufficient_credits:
    "The provider account ran out of credits for this model.",
  invalid_request: "The provider refused the request as invalid.",
  malformed_response: "The model returned output that could not be read.",
};

/**
 * The explanation to show when a model is not progressing, or null.
 *
 * Reported only for a stage that has actually stopped: a model still writing,
 * still rendering, or already ruled has nothing to explain.
 */
export function deriveFailure(facts: LiveModelFacts): LiveFailure | null {
  if (facts.judgeRuled) return null;

  if (facts.artifactUnavailable) {
    return {
      stage: "render",
      kind: "sandbox_unavailable",
      message:
        "The render sandbox was unavailable, so this render could not be judged yet. The round will be retried rather than settled on a guess.",
    };
  }

  const status = facts.executionStatus;

  if (status === "unavailable") {
    const kind = facts.failureKind ?? "unavailable";
    return {
      stage: "generation",
      kind,
      message:
        PROVIDER_MESSAGES[kind] ??
        "This model could not be reached. The round will be retried rather than settled on a guess.",
    };
  }

  if (status === "timeout" || status === "error") {
    const kind = facts.failureKind ?? "provider_error";
    return {
      stage: "generation",
      kind,
      // An unknown class still gets a safe sentence rather than raw provider text.
      message:
        PROVIDER_MESSAGES[kind] ??
        "This model's generation failed before it produced a renderable source.",
    };
  }

  return null;
}

/**
 * Whether a generation failure is infrastructure rather than the model's fault.
 *
 * Used for wording only — the round page and the live panel both say "the round
 * will be retried" rather than implying the model wrote badly, which is what a
 * bare forfeit would suggest.
 */
export function isInfrastructureFailure(kind: string | null): boolean {
  return kind !== null && INFRASTRUCTURE_FAILURES.has(kind);
}
