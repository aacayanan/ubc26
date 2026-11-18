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
