-- F2: Predictions — one pick per user per round per category (F10).
-- Editable while the round is OPEN and before the deadline; final after that.

create table public.predictions (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  category public.prediction_category not null,
  -- The chosen winner. The composite FK guarantees the model actually
  -- participates in the round (referential integrity, not just app checks).
  model_id uuid not null,
  -- On-chain commitment hash (F20). Nullable and scope-agnostic: lightweight
  -- tx records or Anchor both read this column later (G1 gated until M5).
  commitment_hash text,
  -- Settlement marks each prediction's payout; null until scored. Row-level
  -- double-score guard: settlement updates only where points_awarded is null.
  points_awarded integer check (points_awarded is null or points_awarded >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint predictions_participating_model_fk
    foreign key (round_id, model_id)
    references public.round_models (round_id, model_id),
  -- Duplicate submissions rejected at the database level (F10).
  constraint predictions_one_per_category unique (round_id, user_id, category)
);

create trigger predictions_set_updated_at
  before update on public.predictions
  for each row execute function public.set_updated_at();

-- Prediction history per user (F26).
create index predictions_user_created_idx on public.predictions (user_id, created_at);

-- DB backstop for "predictions accepted only in OPEN; late rejected" (F10).
-- The API re-validates; this trigger protects even direct SQL paths.
create or replace function public.ensure_prediction_allowed()
returns trigger
language plpgsql
as $$
declare
  v_status public.round_status;
  v_deadline timestamptz;
begin
  select status, prediction_deadline into v_status, v_deadline
    from public.rounds
    where id = new.round_id;
  if v_status is distinct from 'OPEN' then
    raise exception 'predictions are only accepted while the round is OPEN (currently %)',
      v_status;
  end if;
  if now() > v_deadline then
    raise exception 'prediction deadline has passed for round %', new.round_id;
  end if;
  return new;
end;
$$;

-- Edits are allowed only while the round is OPEN and before the deadline;
-- identity columns are immutable; points_awarded is reserved for settlement
-- (also enforced for clients by the column-level grant in the RLS migration).
create or replace function public.guard_prediction_update()
returns trigger
language plpgsql
as $$
declare
  v_status public.round_status;
  v_deadline timestamptz;
begin
  if new.id is distinct from old.id
    or new.round_id is distinct from old.round_id
    or new.user_id is distinct from old.user_id
    or new.category is distinct from old.category
    or new.created_at is distinct from old.created_at
  then
    raise exception 'predictions cannot change identity columns';
  end if;

  if new.model_id is distinct from old.model_id then
    select status, prediction_deadline into v_status, v_deadline
      from public.rounds
      where id = new.round_id;
    if v_status is distinct from 'OPEN' or now() > v_deadline then
      raise exception 'predictions can only be edited while the round is OPEN and before the deadline';
    end if;
  end if;
  return new;
end;
$$;

create trigger predictions_guard_insert
  before insert on public.predictions
  for each row execute function public.ensure_prediction_allowed();

create trigger predictions_guard_update
  before update on public.predictions
  for each row execute function public.guard_prediction_update();
