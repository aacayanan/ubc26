-- F16: OpenRouter call diagnostics on model_executions.
--
-- `config` already snapshots the generation params sent to the provider (F16).
-- These columns record what the HTTP call itself did. The row-level `attempt`
-- is F17's orchestration attempt; `attempt_count` is the number of HTTP
-- attempts one execution consumed — F16 retries never create new rows.

alter table public.model_executions
  add column provider_request_id text,
  add column attempt_count smallint not null default 1
    constraint model_executions_attempt_count_positive check (attempt_count >= 1),
  add column failure_kind text,
  add column response_meta jsonb not null default '{}'::jsonb;

-- Free text on purpose: the failure set grows with F17 (sandbox/protocol
-- errors), and a check constraint on a live project would mean another
-- migration for every new kind. The allowed values are documented in
-- LLMFailureKind (@ai-showdown/shared).
comment on column public.model_executions.attempt_count is
  'HTTP attempts consumed by this call (F16). Distinct from `attempt` (F17 orchestration).';
comment on column public.model_executions.failure_kind is
  'Coarse provider failure class (LLMFailureKind). NULL when the call succeeded.';
comment on column public.model_executions.provider_request_id is
  'Provider-side id of the last HTTP call that returned one (OpenRouter response id, best-effort).';
comment on column public.model_executions.response_meta is
  'Diagnostics only: requested/served model, finish_reason, usage counters, per-attempt statuses and durations. Never prompts or generated code (publicly readable).';
