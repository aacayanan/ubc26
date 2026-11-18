-- F2: Competition Rounds + round↔model participation, with the lifecycle
-- state-machine triggers (CLAUDE.md / REQUIREMENTS.md F7).

create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  -- Human handle for demos and debugging.
  slug text not null unique,
  challenge_id uuid not null references public.challenges (id),
  status public.round_status not null default 'CREATED',
  prediction_opens_at timestamptz,
  prediction_deadline timestamptz not null,
  -- Lifecycle audit timestamps, set by services as they transition.
  locked_at timestamptz,
  started_at timestamptz,
  settled_at timestamptz,
  archived_at timestamptz,
  -- Why the round was voided when all models failed (F15).
  void_reason text,
  -- Admin who created the round (F8).
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rounds_deadline_after_opens check (
    prediction_opens_at is null or prediction_deadline > prediction_opens_at
  )
);

create trigger rounds_set_updated_at
  before update on public.rounds
  for each row execute function public.set_updated_at();

create index rounds_status_idx on public.rounds (status);
create index rounds_deadline_idx on public.rounds (prediction_deadline);

-- Models participating in a round (F8: a round = challenge + participating
-- models + prediction deadline). The composite PK is the target of the
-- predictions foreign key — a pick must reference a participating model.
create table public.round_models (
  round_id uuid not null references public.rounds (id) on delete cascade,
  model_id uuid not null references public.llm_models (id),
  ordinal integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (round_id, model_id)
);

create trigger round_models_set_updated_at
  before update on public.round_models
  for each row execute function public.set_updated_at();

-- Historical performance lookups per model (F25).
create index round_models_model_idx on public.round_models (model_id);

-- ---------------------------------------------------------------------------
-- State machine: one-directional transitions only, no invalid jumps.
-- NOTE: update the allowed pairs below whenever public.round_status gains
-- new values (see 20261118100000_init.sql).
-- ---------------------------------------------------------------------------
create or replace function public.enforce_round_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'CREATED'    and new.status in ('OPEN', 'CANCELLED'))
      or (old.status = 'OPEN'     and new.status in ('LOCKED', 'CANCELLED'))
      or (old.status = 'LOCKED'   and new.status in ('RUNNING', 'CANCELLED'))
      or (old.status = 'RUNNING'  and new.status in ('EVALUATING', 'FAILED', 'CANCELLED'))
      or (old.status = 'EVALUATING' and new.status in ('SETTLED', 'VOIDED', 'FAILED', 'RETRYING'))
      or (old.status = 'FAILED'   and new.status in ('RETRYING', 'CANCELLED'))
      or (old.status = 'RETRYING' and new.status in ('EVALUATING', 'FAILED', 'CANCELLED'))
      or (old.status = 'SETTLED'  and new.status = 'ARCHIVED')
      or (old.status = 'VOIDED'   and new.status = 'ARCHIVED')
    ) then
      raise exception 'invalid round status transition: % -> %', old.status, new.status;
    end if;
  end if;
  return new;
end;
$$;

-- No modifications to finalized (SETTLED/ARCHIVED) rounds: only the status
-- itself (governed by enforce_round_transition), lifecycle audit timestamps,
-- and updated_at may change. Content columns are frozen.
create or replace function public.prevent_finalized_edits()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('SETTLED', 'ARCHIVED') then
    if new.slug is distinct from old.slug
      or new.challenge_id is distinct from old.challenge_id
      or new.prediction_opens_at is distinct from old.prediction_opens_at
      or new.prediction_deadline is distinct from old.prediction_deadline
      or new.created_by is distinct from old.created_by
    then
      raise exception 'round % is finalized (%); content columns cannot be modified',
        old.id, old.status;
    end if;
  end if;
  return new;
end;
$$;

-- Invalid/incomplete challenges cannot be selected for a round (F12).
create or replace function public.ensure_round_challenge_published()
returns trigger
language plpgsql
as $$
declare
  v_status public.challenge_status;
begin
  select status into v_status
    from public.challenges
    where id = new.challenge_id;
  if v_status is null then
    raise exception 'challenge % does not exist', new.challenge_id;
  end if;
  if v_status <> 'published' then
    raise exception 'challenge % is % and cannot be used for a round',
      new.challenge_id, v_status;
  end if;
  return new;
end;
$$;

create trigger rounds_enforce_transition
  before update of status on public.rounds
  for each row execute function public.enforce_round_transition();

create trigger rounds_prevent_finalized_edits
  before update on public.rounds
  for each row execute function public.prevent_finalized_edits();

create trigger rounds_ensure_challenge_published
  before insert or update of challenge_id on public.rounds
  for each row execute function public.ensure_round_challenge_published();
