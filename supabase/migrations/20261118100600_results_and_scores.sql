-- F2: settlement — Competition Results, the score-events ledger, and
-- User Scores. Idempotency (F18): interrupted settlement never double-scores.

create table public.competition_results (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  model_id uuid not null references public.llm_models (id),
  category public.prediction_category not null,
  status public.result_status not null,
  -- No unique constraint on placement: ties share placement (F15).
  placement integer check (placement is null or placement >= 1),
  -- Unit implied by category: accuracy = tests passed, speed = latency ms,
  -- code_length = non-whitespace chars of the formatted source (F14).
  metric_value numeric,
  -- Why each model won/forfeited (F19).
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Settlement inserts with ON CONFLICT DO NOTHING: re-running a partially
  -- interrupted settlement cannot duplicate result rows (F18).
  unique (round_id, model_id, category)
);

create trigger competition_results_set_updated_at
  before update on public.competition_results
  for each row execute function public.set_updated_at();

create index competition_results_round_idx on public.competition_results (round_id);
create index competition_results_model_idx on public.competition_results (model_id);

-- Per-round settlement ledger: the DB-level latch against double-scoring.
-- Points formula itself is F18; this table only records the delta.
create table public.score_events (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  -- Points only — never money (REQUIREMENTS.md non-negotiable #1).
  points integer not null check (points >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Second settlement attempt for the same user+round hits 23505 (F18).
  unique (round_id, user_id)
);

create trigger score_events_set_updated_at
  before update on public.score_events
  for each row execute function public.set_updated_at();

create table public.user_scores (
  -- 1:1 with users; row is upserted by the profile-sync service (F6).
  user_id uuid primary key references public.users (id) on delete cascade,
  -- Points start at 0 (F6).
  total_points integer not null default 0 check (total_points >= 0),
  -- Leaderboard = points + streaks (F24); semantics computed in F18/F24.
  current_streak integer not null default 0 check (current_streak >= 0),
  longest_streak integer not null default 0 check (longest_streak >= 0),
  -- Audit: which settlement most recently touched this score.
  last_scored_round_id uuid references public.rounds (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_scores_set_updated_at
  before update on public.user_scores
  for each row execute function public.set_updated_at();

-- Leaderboard ordering (F24).
create index user_scores_leaderboard_idx
  on public.user_scores (total_points desc, user_id);
