-- Repair: restore F7's round lifecycle objects where they are missing.
--
-- The hosted project records 20261118101100_round_lifecycle_audit as applied,
-- but none of its objects exist there (no transition_round, no
-- round_transition_events, no audit trigger, no finalized-result guards).
-- create_competition (F8) and lock_due_rounds (F11) both call
-- public.transition_round, so every call failed with
--   function public.transition_round(uuid, unknown, unknown, unknown, uuid)
--   does not exist
--
-- This re-applies 20261118101100 verbatim in an idempotent form. The state
-- machine, audit semantics and guards are unchanged. On a database where F7
-- did run (e.g. the local stack), every statement here is a no-op replacement.

create table if not exists public.round_transition_events (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  from_status public.round_status,
  to_status public.round_status not null,
  reason text,
  actor_id uuid references public.users (id),
  created_at timestamptz not null default now()
);

create index if not exists round_transition_events_round_created_idx
  on public.round_transition_events (round_id, created_at desc);

alter table public.round_transition_events enable row level security;

create or replace function public.transition_round(
  p_round_id uuid,
  p_to_status public.round_status,
  p_expected_status public.round_status default null,
  p_reason text default null,
  p_actor_id uuid default null
)
returns public.round_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_status public.round_status;
begin
  select status
    into v_from_status
    from public.rounds
    where id = p_round_id
    for update;

  if v_from_status is null then
    raise exception 'competition round % not found', p_round_id
      using errcode = 'P0002';
  end if;

  if p_expected_status is not null
     and v_from_status is distinct from p_expected_status then
    raise exception 'round % changed concurrently: expected %, found %',
      p_round_id, p_expected_status, v_from_status
      using errcode = 'P0001';
  end if;

  -- Repeating the target status is a successful retry and creates no duplicate event.
  if v_from_status = p_to_status then
    return v_from_status;
  end if;

  if not (
    (v_from_status = 'CREATED'    and p_to_status in ('OPEN', 'CANCELLED'))
    or (v_from_status = 'OPEN'     and p_to_status in ('LOCKED', 'CANCELLED'))
    or (v_from_status = 'LOCKED'   and p_to_status in ('RUNNING', 'CANCELLED'))
    or (v_from_status = 'RUNNING'  and p_to_status in ('EVALUATING', 'FAILED', 'CANCELLED'))
    or (v_from_status = 'EVALUATING' and p_to_status in ('SETTLED', 'VOIDED', 'FAILED', 'RETRYING'))
    or (v_from_status = 'FAILED'   and p_to_status in ('RETRYING', 'CANCELLED'))
    or (v_from_status = 'RETRYING' and p_to_status in ('EVALUATING', 'FAILED', 'CANCELLED'))
    or (v_from_status = 'SETTLED'  and p_to_status = 'ARCHIVED')
    or (v_from_status = 'VOIDED'   and p_to_status = 'ARCHIVED')
  ) then
    raise exception 'invalid round status transition: % -> %',
      v_from_status, p_to_status
      using errcode = 'P0001';
  end if;

  perform set_config('app.round_transition_explicit_audit', 'true', true);

  update public.rounds
  set
    status = p_to_status,
    locked_at = case when p_to_status = 'LOCKED'
                     then coalesce(locked_at, now()) else locked_at end,
    started_at = case when p_to_status = 'RUNNING'
                      then coalesce(started_at, now()) else started_at end,
    settled_at = case when p_to_status = 'SETTLED'
                      then coalesce(settled_at, now()) else settled_at end,
    archived_at = case when p_to_status = 'ARCHIVED'
                       then coalesce(archived_at, now()) else archived_at end
  where id = p_round_id;

  insert into public.round_transition_events (
    round_id, from_status, to_status, reason, actor_id
  ) values (
    p_round_id, v_from_status, p_to_status, p_reason, p_actor_id
  );

  perform set_config('app.round_transition_explicit_audit', 'false', true);

  return p_to_status;
end;
$$;

revoke all on function public.transition_round(
  uuid, public.round_status, public.round_status, text, uuid
) from public, anon, authenticated;
grant execute on function public.transition_round(
  uuid, public.round_status, public.round_status, text, uuid
) to service_role;

drop policy if exists round_transition_events_public_read
  on public.round_transition_events;
create policy round_transition_events_public_read
  on public.round_transition_events
  for select
  using (true);

create or replace function public.audit_round_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status
     and coalesce(
       current_setting('app.round_transition_explicit_audit', true),
       ''
     ) <> 'true' then
    insert into public.round_transition_events (
      round_id, from_status, to_status
    ) values (
      new.id, old.status, new.status
    );
  end if;
  return new;
end;
$$;

drop trigger if exists rounds_audit_transition on public.rounds;
create trigger rounds_audit_transition
  after update of status on public.rounds
  for each row execute function public.audit_round_transition();

create or replace function public.prevent_finalized_edits()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('SETTLED', 'VOIDED', 'ARCHIVED') then
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

create or replace function public.prevent_finalized_result_edits()
returns trigger
language plpgsql
as $$
declare
  v_status public.round_status;
  v_round_id uuid;
begin
  v_round_id := case
    when tg_op = 'DELETE' then old.round_id
    else new.round_id
  end;

  select status into v_status
    from public.rounds
    where id = v_round_id;

  if v_status in ('SETTLED', 'VOIDED', 'ARCHIVED') then
    raise exception 'results for finalized round % cannot be modified',
      v_round_id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists competition_results_prevent_finalized_edits
  on public.competition_results;
create trigger competition_results_prevent_finalized_edits
  before update or delete on public.competition_results
  for each row execute function public.prevent_finalized_result_edits();

drop trigger if exists score_events_prevent_finalized_edits
  on public.score_events;
create trigger score_events_prevent_finalized_edits
  before update or delete on public.score_events
  for each row execute function public.prevent_finalized_result_edits();
