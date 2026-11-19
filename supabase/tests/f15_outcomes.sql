-- F15 acceptance test — failure, tie and void behavior at the database level.
--
-- How to run: paste this entire script into the hosted Supabase SQL editor
-- (runs as postgres) and execute it in one go. Every assertion raises
-- `FAIL: …` if violated; a final `all assertions passed` select confirms
-- success. Everything runs inside one transaction and is rolled back — no data
-- persists.
--
-- Covers the F15 acceptance criteria that live in the database:
--   * every model outcome has a persisted status (the enum carries the
--     conformance vocabulary)
--   * one outcome row per round, shaped so a void can never name a winner and a
--     settled round can never lack one
--   * a round cannot finalize while a conformance stake is unsettled — the latch
--     that makes "a void returns stakes" true rather than hoped for
--   * a finalized round's outcome is immutable

begin;

-- ---------------------------------------------------------------------------
-- Assertion helpers (rolled back with the transaction)
-- ---------------------------------------------------------------------------
create or replace function pg_temp.assert_ok(p_desc text, p_sql text)
returns void
language plpgsql
as $$
begin
  execute p_sql;
exception when others then
  raise exception 'FAIL: % — unexpected error [%] %', p_desc, sqlstate, sqlerrm;
end;
$$;

create or replace function pg_temp.assert_fails(p_desc text, p_sql text,
  p_expected_state text, p_msg_pattern text default null)
returns void
language plpgsql
as $$
declare
  v_state text := null;
  v_msg text := null;
begin
  begin
    execute p_sql;
  exception when others then
    v_state := sqlstate;
    v_msg := sqlerrm;
    if v_state = p_expected_state
      and (p_msg_pattern is null or v_msg like p_msg_pattern) then
      return;
    end if;
    raise exception 'FAIL: % — expected [%] %, got [%] %',
      p_desc, p_expected_state, coalesce(p_msg_pattern, '(any message)'), v_state, v_msg;
  end;
  raise exception 'FAIL: % — statement was accepted but should have been rejected',
    p_desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000',
  'ffffffff-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
  'f15@ai-showdown.test', 'not-a-real-hash', now(), '{}'::jsonb, '{}'::jsonb,
  now(), now());

insert into public.users (id, display_name)
  values ('ffffffff-0000-0000-0000-000000000001', 'F15')
on conflict (id) do nothing;

insert into public.llm_models (slug, name, openrouter_model_id) values
  ('f15-a', 'Model A', 'org/f15-a'),
  ('f15-b', 'Model B', 'org/f15-b')
on conflict (slug) do nothing;

create or replace function pg_temp.make_round(p_slug text, p_status public.round_status)
returns uuid
language plpgsql
as $$
declare
  v_challenge uuid;
  v_round uuid;
begin
  insert into public.challenges (
    slug, version, title, prompt, language, status, entry_point,
    style_constraints, target_duration_ms, frame_count, frame_width,
    frame_height, deterministic_checks, judge_rubric, reference_impl,
    reference_validated_at
  ) values (
    p_slug || '-brief', 1, 'Donut', 'Draw a donut.', 'javascript', 'published',
    'drawFrame', 'Flat fills.', 1000, 2, 320, 240,
    '[{"kind":"process_exit","expect":0},
      {"kind":"no_uncaught_error"},
      {"kind":"frames_emitted","expect":2},
      {"kind":"frame_dimensions","expect":"320x240"},
      {"kind":"non_blank"}]'::jsonb,
    '[{"id":"subject","question":"Is it a donut?","weight":1}]'::jsonb,
    'function drawFrame() {}', now()
  ) returning id into v_challenge;

  insert into public.rounds (
    slug, challenge_id, status, prediction_deadline, locked_at
  ) values (
    p_slug, v_challenge, p_status, now() + interval '1 hour',
    case when p_status in ('OPEN', 'CREATED') then null else now() end
  ) returning id into v_round;

  insert into public.round_models (round_id, model_id)
  select v_round, id from public.llm_models where slug in ('f15-a', 'f15-b');

  return v_round;
end;
$$;

-- Move a round through the lifecycle to EVALUATING, where F15 resolves it.
create or replace function pg_temp.to_evaluating(p_slug text)
returns uuid
language plpgsql
as $$
declare
  v_round uuid := pg_temp.make_round(p_slug, 'OPEN');
begin
  update public.rounds set status = 'LOCKED', locked_at = now()
    where id = v_round;
  update public.rounds set status = 'RUNNING', started_at = now()
    where id = v_round;
  update public.rounds set status = 'EVALUATING' where id = v_round;
  return v_round;
end;
$$;

-- Advance an OPEN round's fixture to EVALUATING without creating a new one.
create or replace function pg_temp.advance_to_evaluating(p_round uuid)
returns void
language plpgsql
as $$
begin
  update public.rounds set status = 'LOCKED', locked_at = now()
    where id = p_round;
  update public.rounds set status = 'RUNNING', started_at = now()
    where id = p_round;
  update public.rounds set status = 'EVALUATING' where id = p_round;
end;
$$;

-- A stake on a round, in the post-pivot conformance category.
create or replace function pg_temp.stake(p_round uuid, p_model_slug text)
returns uuid
language plpgsql
as $$
declare
  v_prediction uuid;
begin
  insert into public.predictions (round_id, user_id, category, model_id)
  values (
    p_round,
    'ffffffff-0000-0000-0000-000000000001',
    'conformance',
    (select id from public.llm_models where slug = p_model_slug)
  ) returning id into v_prediction;
  return v_prediction;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The enum carries the conformance vocabulary (every failure path has a
--    persisted status).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'result_status' and e.enumlabel = 'conformed'
  ) then
    raise exception 'FAIL: result_status is missing the conformed value';
  end if;

  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'result_status' and e.enumlabel = 'not_conformed'
  ) then
    raise exception 'FAIL: result_status is missing the not_conformed value';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. One outcome per round; settled requires a winner, void forbids one.
-- ---------------------------------------------------------------------------
select pg_temp.assert_ok('a void outcome needs no winner',
  $sql$insert into public.round_outcomes (round_id, kind, reason)
      values (pg_temp.to_evaluating('f15-void'), 'voided', 'Every model forfeited.')
      $sql$);

do $$
declare
  v_round uuid;
begin
  select round_id into v_round
    from public.round_outcomes where reason = 'Every model forfeited.';

  -- One row per round: a second write must be an upsert, not a duplicate.
  begin
    insert into public.round_outcomes (round_id, kind, reason)
      values (v_round, 'voided', 'Again.');
    raise exception 'FAIL: a second outcome for a round was accepted';
  exception when unique_violation then
    null;
  end;
end $$;

select pg_temp.assert_fails(
  'a settled outcome without a winner is rejected',
  $sql$insert into public.round_outcomes (round_id, kind, reason)
      values (pg_temp.to_evaluating('f15-bad-settled'), 'settled', 'Nobody won?')
      $sql$,
  '23514', '%round_outcomes_settled_shape%');

select pg_temp.assert_fails(
  'a void outcome carrying a winner is rejected',
  $sql$insert into public.round_outcomes (round_id, kind, winner_model_id, tie_break, reason)
      values (pg_temp.to_evaluating('f15-bad-void'), 'voided',
        (select id from public.llm_models where slug = 'f15-a'),
        'crowd-vote', 'Contradictory.')
      $sql$,
  '23514', '%round_outcomes_settled_shape%');

-- ---------------------------------------------------------------------------
-- 3. A round cannot finalize while a conformance stake is unsettled — including
--    a void, which must return every stake rather than silently keeping it.
-- ---------------------------------------------------------------------------
do $$
declare
  v_round uuid := pg_temp.make_round('f15-unsettled', 'OPEN');
  v_prediction uuid;
begin
  -- Stakes are only accepted while OPEN, so place it before advancing.
  v_prediction := pg_temp.stake(v_round, 'f15-a');
  perform pg_temp.advance_to_evaluating(v_round);

  -- Settling the round with an open stake must be refused.
  begin
    update public.rounds set status = 'SETTLED', settled_at = now()
      where id = v_round;
    raise exception 'FAIL: a round settled while a stake was unsettled';
  exception when others then
    if sqlerrm not like '%unsettled stake%' then
      raise;
    end if;
  end;

  -- Same on the void path.
  begin
    update public.rounds set status = 'VOIDED' where id = v_round;
    raise exception 'FAIL: a round voided while a stake was unsettled';
  exception when others then
    if sqlerrm not like '%unsettled stake%' then
      raise;
    end if;
  end;

  -- Settling the stake as void (points returned, zero awarded) unblocks it.
  update public.predictions
    set settled_at = now(), settlement_outcome = 'void', points_awarded = 0
    where id = v_prediction;

  update public.rounds set status = 'VOIDED' where id = v_round;
end $$;

-- Legacy categories are exempt: a pre-pivot prediction has no conformance stake
-- to settle, so it must not block finalization.
do $$
declare
  v_round uuid := pg_temp.make_round('f15-legacy', 'OPEN');
begin
  insert into public.predictions (round_id, user_id, category, model_id)
  values (v_round, 'ffffffff-0000-0000-0000-000000000001', 'accuracy',
    (select id from public.llm_models where slug = 'f15-a'));

  perform pg_temp.advance_to_evaluating(v_round);

  update public.rounds set status = 'SETTLED', settled_at = now()
    where id = v_round;
end $$;

-- ---------------------------------------------------------------------------
-- 4. A finalized round's outcome is immutable.
-- ---------------------------------------------------------------------------
do $$
declare
  v_round uuid := pg_temp.to_evaluating('f15-frozen');
begin
  insert into public.round_outcomes (round_id, kind, reason)
    values (v_round, 'voided', 'Every model forfeited.');

  update public.rounds set status = 'VOIDED' where id = v_round;
end $$;

select pg_temp.assert_fails(
  'a voided round outcome cannot be edited',
  $sql$update public.round_outcomes set reason = 'Rewritten.'
      where round_id = (select id from public.rounds where slug = 'f15-frozen')$sql$,
  'P0001', '%finalized round%');

select pg_temp.assert_fails(
  'a voided round outcome cannot be deleted',
  $sql$delete from public.round_outcomes
      where round_id = (select id from public.rounds where slug = 'f15-frozen')$sql$,
  'P0001', '%finalized round%');

-- ---------------------------------------------------------------------------
-- 5. Outcomes are public record, like competition_results.
-- ---------------------------------------------------------------------------
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
set local request.jwt.claim.sub to '';

do $$
declare
  n int;
begin
  select count(*) into n from public.round_outcomes;
  if n < 1 then
    raise exception 'FAIL: anon cannot read round_outcomes (results view)';
  end if;
end $$;

reset role;

select 'all assertions passed' as result;

rollback;
