// Categories that users can make predictions on
export type PredictionCategory = "accuracy" | "speed" | "code_length";

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
export type ResultStatus = "qualified" | "forfeited" | "failed" | "unavailable";

// Mirrors the public.tx_status enum in
// supabase/migrations/20261118100000_init.sql — keep the values in sync.
export type TxStatus = "pending" | "confirmed" | "failed" | "timeout";

// Mirrors the public.execution_run_type enum in
// supabase/migrations/20261118100000_init.sql — keep the values in sync.
export type ExecutionRunType = "generation" | "warmup" | "benchmark";

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
