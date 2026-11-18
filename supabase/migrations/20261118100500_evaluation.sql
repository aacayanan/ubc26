-- F2: evaluation — Model Executions and Test Results.
-- Idempotency (F17): restarting an interrupted evaluation must not duplicate
-- completed execution records — enforced by the composite unique constraints.

create table public.model_executions (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  model_id uuid not null references public.llm_models (id),
  run_type public.execution_run_type not null,
  -- One generation attempt per model per round is the normal case; benchmark
  -- rows repeat via attempt (F14 warm-up + repeated runs).
  attempt integer not null default 1 check (attempt >= 1),
  -- Snapshot at execution time — survives later catalog edits (F16).
  openrouter_model_id text not null,
  config jsonb not null default '{}'::jsonb,
  status public.execution_status not null default 'pending',
  -- Generated source for generation runs (F17: store generated solutions).
  solution_code text,
  latency_ms integer,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Execution idempotency: an interrupted run re-inserting the same key
  -- hits 23505 and resumes by updating the existing row instead (F17).
  unique (round_id, model_id, run_type, attempt)
);

create trigger model_executions_set_updated_at
  before update on public.model_executions
  for each row execute function public.set_updated_at();

-- Live progress display during RUNNING/EVALUATING (F27).
create index model_executions_round_status_idx
  on public.model_executions (round_id, status);

create table public.test_results (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references public.model_executions (id) on delete cascade,
  test_case_id uuid not null references public.test_cases (id),
  passed boolean not null,
  -- Sandbox capture (F13).
  stdout text not null default '',
  stderr text not null default '',
  exit_code integer,
  duration_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One verdict per test per execution — no duplicate rows on retry.
  unique (execution_id, test_case_id)
);

create trigger test_results_set_updated_at
  before update on public.test_results
  for each row execute function public.set_updated_at();
