// What a stake or result row is about. Mirrors public.prediction_category in
// supabase/migrations/20261119000600_f15_failure_tie_void.sql. `conformance`
// is the post-pivot category; accuracy/speed/code_length are the retired
// pre-pivot categories, kept only so historical rows still type-check.
export type PredictionCategory =
  "conformance" | "accuracy" | "speed" | "code_length";

// What a `public.score_events` row settles (F18). Mirrors the kind check in
// supabase/migrations/20261119000800_f18_stakes_and_votes.sql. `stake` is the
// credited return on a settled stake (0 for a loss or a void); `fan_favorite`
// is the crowd-vote award. A user can hold both kinds in one round.
export type ScoreEventKind = "stake" | "fan_favorite";
// Represents the information needed to identify an LLM
export interface LLMModel {
  id: string;
  name: string;
  provider: string;
}

// Competition lifecycle states. Mirrors the public.round_status enum in
// supabase/migrations/20261118100000_init.sql — keep the values in sync.
// Transition rules live in the DB trigger (20261118100300_rounds.sql) and,
// later, in the F7 state-machine service.
export type RoundStatus =
  | "CREATED"
  | "OPEN"
  | "LOCKED"
  | "RUNNING"
  | "EVALUATING"
  | "SETTLED"
  | "ARCHIVED"
  | "CANCELLED"
  | "FAILED"
  | "RETRYING"
  | "VOIDED";

// Mirrors the public.execution_status enum in
// supabase/migrations/20261118100000_init.sql — keep the values in sync.
export type ExecutionStatus =
  "pending" | "running" | "succeeded" | "timeout" | "error" | "unavailable";

// Mirrors the public.result_status enum in
// supabase/migrations/20261118100000_init.sql — keep the values in sync.
// Post-pivot (F15): conformed / not_conformed are the judge ruling on a
// gate-passing render; forfeited means the render failed the deterministic
// gate; unavailable is infrastructure (a retryable non-verdict). qualified /
// failed are pre-pivot values kept for historical rows only.
export type ResultStatus =
  | "conformed"
  | "not_conformed"
  | "qualified"
  | "forfeited"
  | "failed"
  | "unavailable";

// Mirrors the public.tx_status enum in
// supabase/migrations/20261118100000_init.sql — keep the values in sync.
export type TxStatus = "pending" | "confirmed" | "failed" | "timeout";

// Mirrors the public.tx_purpose enum: the four values in
// supabase/migrations/20261118100000_init.sql plus the three SOL wagering
// values added by 20261120000100_sol_wagering_enums.sql — keep them in sync.
export const TX_PURPOSES = [
  "prediction_commitment",
  "round_record",
  "settlement",
  "wallet_verification",
  "wager",
  "payout",
  "betting_close",
] as const;
export type TxPurpose = (typeof TX_PURPOSES)[number];

// Mirrors the public.execution_run_type enum in
// supabase/migrations/20261118100000_init.sql — keep the values in sync.
// `judge` (F31/F17, migration 20261119000700) is the vision model's ruling call;
// its `subject_model_id` names the competitor whose frames it saw.
export type ExecutionRunType = "generation" | "warmup" | "benchmark" | "judge";

// Mirrors the public.test_kind enum in
// supabase/migrations/20261118100000_init.sql — keep the values in sync.
export type TestKind = "public" | "hidden";

// ---------------------------------------------------------------------------
// F16 OpenRouter outcomes.
// ---------------------------------------------------------------------------

// Coarse provider failure classes. Mirrors model_executions.failure_kind (free
// text in the DB on purpose — the set grows as F17 adds sandbox failures).
export type LLMFailureKind =
  | "timeout"
  | "network"
  | "rate_limited"
  | "provider_error"
  | "model_unavailable"
  | "auth"
  | "insufficient_credits"
  | "invalid_request"
  | "malformed_response";

// ---------------------------------------------------------------------------
// F13 sandbox result protocol.
//
// The container reports *observations*; the host decides pass/fail by comparing
// the returned value against `test_cases.expected_output`. Expected answers
// never enter the container, so a verdict cannot be forged there. Bump
// SANDBOX_PROTOCOL_VERSION when this shape changes — the version is recorded on
// model_executions.harness_protocol.
// ---------------------------------------------------------------------------

export const SANDBOX_PROTOCOL_VERSION = 1;

// What one test case produced inside the container.
// `value` is the solution's JSON-serialisable return value, when it returned.
export type SandboxTestOutcome = "returned" | "timeout" | "error";

export interface SandboxTestRecord {
  t: "test";
  protocol: typeof SANDBOX_PROTOCOL_VERSION;
  ordinal: number;
  outcome: SandboxTestOutcome;
  /** Present only when outcome is "returned". */
  value?: unknown;
  /** Raw child stdout/stderr, already truncated in-container. */
  stdout: string;
  stderr: string;
  /** True when the stream exceeded the capture cap and was cut. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Exit status of the child process; null when it never started. */
  exitCode: number | null;
  durationMs: number;
  /** Coarse machine-readable reason, e.g. "exception", "memory", "process_limit". */
  failureKind: string | null;
}

export interface SandboxStartRecord {
  t: "start";
  protocol: typeof SANDBOX_PROTOCOL_VERSION;
  tests: number;
}

export interface SandboxEndRecord {
  t: "end";
  protocol: typeof SANDBOX_PROTOCOL_VERSION;
  reason: "completed" | "budget" | "internal";
}

export type SandboxRecord =
  SandboxStartRecord | SandboxTestRecord | SandboxEndRecord;

// Per-test row destined for public.test_results.
export interface TestResultSummary {
  testCaseId: string;
  ordinal: number;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// F12/F14 render sandbox.
//
// A visual brief is rendered by a browser, not by a Python child: the model
// writes `function <entryPoint>(t, ctx, canvas)`, and a headless Chromium calls
// it once per frame at an explicit time step. Frame time is
// `frameIndex / (frameCount - 1) * durationMs` so the same code always yields
// the same frames — never wall-clock.
//
// The host decides the deterministic checks (F14); the container only reports
// what happened. Bump RENDER_PROTOCOL_VERSION when this shape changes.
// ---------------------------------------------------------------------------

export const RENDER_PROTOCOL_VERSION = 1;

/** Check kinds a complete brief must define (the F12 publish gate). */
export type DeterministicCheckKind =
  | "process_exit"
  | "no_uncaught_error"
  | "frames_emitted"
  | "frame_dimensions"
  | "non_blank";

export interface DeterministicCheck {
  kind: DeterministicCheckKind;
  /** Expected value; meaning depends on `kind` (exit code, count, "WxH"). */
  expect?: number | string;
}

export interface JudgeCriterion {
  id: string;
  question: string;
  weight: number;
}

/** The job the host sends to the render container on stdin. */
export interface RenderJob {
  protocol: typeof RENDER_PROTOCOL_VERSION;
  source: string;
  entryPoint: string;
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
  targetDurationMs: number;
  /** Hard per-frame ceiling inside the page; the host also caps wall-clock. */
  frameTimeoutMs: number;
}

export interface RenderedFrame {
  index: number;
  /** PNG bytes as base64, no data-URL prefix. */
  png: string;
  /** True when the frame is a single flat colour (the non_blank check input). */
  blank: boolean;
  /** Distinct-colour count sampled from the frame, for diagnostics. */
  distinctColors: number;
  /**
   * The canvas size the solution actually left the frame at — measured, not
   * the size it was given. A solution that resizes the canvas must not pass
   * the frame_dimensions check by accident.
   */
  width: number;
  height: number;
}

/** The single NDJSON line the render container emits. */
export interface RenderResultRecord {
  t: "render";
  protocol: typeof RENDER_PROTOCOL_VERSION;
  ok: boolean;
  /** Set when the run itself failed (bad source, page crash, budget). */
  error: string | null;
  /** An uncaught page error, if the page threw while drawing. */
  pageError: string | null;
  frames: RenderedFrame[];
}

// ---------------------------------------------------------------------------
// F17 chunked generation.
//
// Generation is split into chunks so the audience can watch the renderer take
// shape. The policy below is the fairness rule (REQUIREMENTS.md non-negotiable
// #10): every model in a round receives the identical brief, chunk policy and
// per-chunk token cap, and the policy is recorded on each execution so a run
// stays explainable after the constants change.
// ---------------------------------------------------------------------------

export interface ChunkPolicy {
  /** Ceiling on `max_tokens` for one chunk's request. */
  maxTokensPerChunk: number;
  /**
   * Hard stop on chunks per model. The last chunk is asked to finish the
   * function, so a model that would otherwise ramble is bounded rather than
   * left generating until the client times out.
   */
  maxChunks: number;
  /** Template version string, stored with each chunk (reproducibility). */
  promptTemplateVersion: string;
}

/** One chunk as stored: what it added, and what it cost. */
export interface StoredChunk {
  chunkIndex: number;
  source: string;
  /**
   * The provider's `finish_reason` for this chunk. `stop` (or a null the
   * provider omits on a clean finish) means the model itself declared this
   * chunk's answer complete — which is what lets assembly prefer a prefix the
   * model finished over a later chunk that was cut off.
   */
  finishReason?: string | null;
}

// ---------------------------------------------------------------------------
// F31 judge protocol.
//
// The judge is asked for one strict JSON object; the host parses and validates
// it rather than trusting prose. A reply that is not that object is a typed
// `malformed_response` failure, never a silent pass or fail.
// ---------------------------------------------------------------------------

export interface JudgeCriterionVerdict {
  id: string;
  question: string;
  /**
   * The criterion's weight from the brief's rubric, copied onto the verdict so
   * the results view can present how much each answer counted without having to
   * re-read a brief that may since have been re-versioned (F19).
   */
  weight: number;
  passed: boolean;
  reason: string;
}

export interface JudgeRuling {
  /** Overall conformance: every criterion passing is what `true` means. */
  conformed: boolean;
  reason: string;
  criteria: JudgeCriterionVerdict[];
}

// ---------------------------------------------------------------------------
// F19 results + replay.
//
// The payoff screen. After a round runs, is judged and settled, a viewer reads
// exactly why it landed where it did: which model conformed, which the crowd
// named best, why each other model forfeited or fell off brief, the final odds,
// and the rendered artifacts they can replay. These shapes are the contract
// between the results service, its APIs and the results pages.
// ---------------------------------------------------------------------------

/**
 * How a settled round reads at a glance. `pending` is a round that has not been
 * finally decided yet — it is shown by the detail page but not listed in
 * results, because there is no outcome to report.
 */
export type ResultDisplayState =
  | "winner"
  | "tie"
  | "all-forfeited"
  | "no-conformer"
  | "judge-unavailable"
  | "voided"
  | "pending";

/** One row in the results list. */
export interface ResultSummary {
  roundId: string;
  slug: string;
  briefTitle: string;
  kind: "settled" | "voided";
  displayState: ResultDisplayState;
  /** Name of the model that conformed to the brief, or null. */
  conformedModel: string | null;
  /** Name of the crowd's fan-favorite, or null when nobody voted. */
  crowdModel: string | null;
  /** Gross Devnet SOL wagered on the round. */
  poolSol: number;
  reason: string;
  settledAt: string;
}

/** One model's outcome within a round's full result. */
export interface ResultModel {
  modelId: string;
  name: string;
  ordinal: number;
  status:
    "conformed" | "not_conformed" | "forfeited" | "unavailable" | "pending";
  /** Plain-language reason the model forfeited or was unrunnable, or null. */
  forfeitReason: string | null;
  /** Deterministic gate: the checks that decided whether it could be judged. */
  gate: {
    passed: boolean;
    failureReason: string | null;
    checks: Array<{ kind: string; passed: boolean; reason: string }>;
  } | null;
  /** The judge's ruling with weighted per-criterion reasons, or null if unjudged. */
  judge: {
    verdict: "conformed" | "not_conformed" | "unavailable";
    reason: string;
    criteria: Array<{
      id: string;
      question: string;
      weight: number;
      passed: boolean;
      reason: string;
    }>;
  } | null;
  /** Stored artifact frames (the replay fallback). */
  frames: RenderedFrame[];
  /** The finished source, for the quarantined in-browser replay. */
  solutionCode: string | null;
  /** Points staked on this model, and the resulting odds. */
  staked: number;
  multiplier: number | null;
  share: number;
  isWinner: boolean;
  isFanFavorite: boolean;
}

/** A round's full result, as the detail + replay page reads it. */
export interface RoundResult {
  roundId: string;
  slug: string;
  briefTitle: string;
  briefPrompt: string;
  status: string;
  /** True once the round is past OPEN; only then are code and frames present. */
  revealed: boolean;
  displayState: ResultDisplayState;
  /** Geometry the replay needs to draw the same frames the judge saw. */
  replay: {
    entryPoint: string;
    frameWidth: number;
    frameHeight: number;
    targetDurationMs: number;
    frameCount: number;
  };
  outcome: {
    kind: "settled" | "voided";
    winnerModelId: string | null;
    fanFavoriteModelId: string | null;
    tieBreak: "sole-conformer" | "crowd-vote" | "stable-order" | null;
    reason: string;
    allForfeited: boolean;
  } | null;
  pool: {
    /** Gross Devnet SOL wagered on the round. */
    potSol: number;
    models: Array<{
      modelId: string;
      name: string;
      /** Devnet SOL wagered on this model. */
      staked: number;
      multiplier: number | null;
      share: number;
    }>;
  };
  crowd: { counts: Record<string, number> } | null;
  models: ResultModel[];
  /** The viewer's own Devnet SOL wagers, or null when signed out / none. */
  viewerStake: {
    modelId: string;
    amountSol: number;
    outcome: "won" | "lost" | "void" | null;
    payoutSol: number | null;
  } | null;
}

// ---------------------------------------------------------------------------
// F27 live round progress.
//
// The watch contract: `GET /api/rounds/[id]/progress` returns this shape, the
// round page polls it while a round runs, and the dev watch page reads it too.
// It lives here rather than in the service because a client component needs it
// and the service is `server-only` — hand-redeclaring it in the page is how the
// two drift apart.
//
// The payload is deliberately trimmed for polling. A full artifact can be
// megabytes of base64; the live view shows one frame per model, and the full
// set stays on the results API where it belongs.
// ---------------------------------------------------------------------------

/** Where a model is in the pipeline, as a viewer sees it. */
export type LiveModelState =
  | "pending"
  | "generating"
  | "rendering"
  | "judging"
  | "conformed"
  | "not_conformed"
  | "forfeited"
  | "unavailable";

/**
 * Why a model is not progressing, in terms a viewer can act on.
 *
 * `stage` is what failed; `kind` is the coarse class. Neither carries provider
 * text — `message` is written for a viewer and never echoes a provider string.
 */
export type LiveFailureStage = "generation" | "render" | "judge";

export interface LiveFailure {
  stage: LiveFailureStage;
  /** Coarse class, mirroring `LLMFailureKind` where one applies. */
  kind: string;
  /** Viewer-safe sentence. Never provider text. */
  message: string;
}

/** One chunk's progressive render: what it parsed to, and the frames it drew. */
export interface LivePreview {
  chunkIndex: number;
  /** False is the "compiling…" state: the partial source did not parse yet. */
  parseOk: boolean;
  rendered: boolean;
  frames: RenderedFrame[];
}

export interface LiveModelProgress {
  modelId: string;
  name: string;
  ordinal: number;
  state: LiveModelState;
  /** The source written so far, revealed only after the round locks. */
  code: string | null;
  /**
   * The newest source that actually parsed — what the quarantined iframe should
   * run. `code` may be ahead of this (a half-written function), and running that
   * would throw on its first frame instead of showing the last good render.
   */
  renderableCode: string | null;
  /** True while the latest chunk has not parsed yet — the "compiling…" state. */
  compiling: boolean;
  /** One entry per stored chunk, oldest first. The newest parseable one wins. */
  previews: LivePreview[];
  chunks: {
    /** How many chunks have landed so far. */
    generated: number;
    /** The policy ceiling for this round, from the execution's snapshot. */
    expected: number;
    /**
     * True once the model has stopped writing. The ceiling is not a target: a
     * model that finished in one chunk of three is done, not a third done.
     */
    complete: boolean;
  };
  /** The finished render's last frame only; the full set is on the results API. */
  frames: RenderedFrame[];
  /** How many frames the finished render produced, even though one is sent. */
  frameCount: number;
  gatePassed: boolean | null;
  judge: {
    verdict: "conformed" | "not_conformed" | "unavailable";
    reason: string;
    criteria: Array<{
      id: string;
      question: string;
      weight: number;
      passed: boolean;
      reason: string;
    }>;
  } | null;
  /** Viewer-safe explanation when the model stopped, or null while it is fine. */
  failure: LiveFailure | null;
}

export interface LiveRoundProgress {
  roundId: string;
  slug: string;
  status: RoundStatus;
  /** True once the round is past OPEN; only then is anything renderable shown. */
  revealed: boolean;
  brief: { title: string; prompt: string } | null;
  /** Geometry the quarantined replay needs; null until the round is revealed. */
  replay: {
    entryPoint: string;
    frameWidth: number;
    frameHeight: number;
    targetDurationMs: number;
    frameCount: number;
  } | null;
  models: LiveModelProgress[];
  /** A round-level explanation while it is being retried or has failed. */
  retry: { message: string } | null;
  /** The round's recorded outcome, once F15/F18 have written one. */
  outcome: {
    kind: "settled" | "voided";
    winnerModelId: string | null;
    fanFavoriteModelId: string | null;
    reason: string;
  } | null;
}
