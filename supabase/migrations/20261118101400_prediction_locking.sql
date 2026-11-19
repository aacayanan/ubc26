-- F11: lock OPEN rounds at their prediction deadline, idempotently.
--
-- Why a database function rather than an app-side loop:
--   * the set of due rounds and the transition are one transaction, so a
--     process that dies mid-batch leaves every already-locked round in a
--     durable LOCKED state and the rest still OPEN for the next run;
--   * `for update skip locked` lets two overlapping invocations (a cron tick
--     plus a manual trigger during the demo) split the work instead of one
--     aborting on a concurrent change;
--   * `transition_round` (20261118101100) already makes a repeated target
--     status a no-op, so re-running cannot duplicate the audit trail.
--
-- Predictions themselves are already rejected after the deadline by the
-- trigger in 20261118100400_predictions.sql, independent of lock state. This
-- migration closes the other half: the round must *leave* OPEN so that the
-- RUNNING stage, and any write path that only checks status, cannot proceed.

-- The due-round scan only ever considers OPEN rows. `rounds_status_idx` plus
-- `rounds_deadline_idx` already exist; this partial index makes the exact
-- predicate (`status = 'OPEN' and prediction_deadline <= now()`) a single
-- ordered range read as the rounds table grows.
create index if not exists rounds_open_deadline_idx
  on public.rounds (prediction_deadline)
  where status = 'OPEN';

create or replace function public.lock_due_rounds(
  p_now timestamptz default now(),
  p_limit integer default 100,
  p_reason text default null
)
returns table (
  round_id uuid,
  previous_status public.round_status,
  new_status public.round_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round record;
  v_reason text;
begin
  if p_limit is null or p_limit <= 0 then
    raise exception 'p_limit must be a positive integer'
      using errcode = '22023';
  end if;

  if p_now is null then
    raise exception 'p_now must not be null' using errcode = '22023';
  end if;

  v_reason := coalesce(
    nullif(btrim(p_reason), ''),
    'prediction deadline reached'
  );

  for v_round in
    select r.id, r.status
      from public.rounds r
     where r.status = 'OPEN'
       and r.prediction_deadline <= p_now
     order by r.prediction_deadline
     limit p_limit
     for update skip locked
  loop
    -- transition_round re-reads the row under its own lock and refuses an
    -- unexpected status, so the only way this raises is a genuine bug.
    perform public.transition_round(
      v_round.id,
      'LOCKED'::public.round_status,
      v_round.status,
      v_reason,
      null
    );

    round_id := v_round.id;
    previous_status := v_round.status;
    new_status := 'LOCKED'::public.round_status;
    return next;
  end loop;
end;
$$;

-- Service-role only: locking a round is a server operation, never a client
-- one. The SECURITY DEFINER body exists so it can call the equally restricted
-- `transition_round`.
revoke all on function public.lock_due_rounds(timestamptz, integer, text)
  from public, anon, authenticated;
grant execute on function public.lock_due_rounds(timestamptz, integer, text)
  to service_role;

comment on function public.lock_due_rounds(timestamptz, integer, text) is
  'F11: transitions every OPEN round whose prediction_deadline <= p_now to LOCKED. Idempotent and safe to run concurrently or repeatedly; returns the rounds it actually locked.';
