-- F14 acceptance test — rendered artifacts and the deterministic gate verdict.
--
-- How to run: paste this entire script into the hosted Supabase SQL editor
-- (runs as postgres) and execute it in one go. Every assertion raises
-- `FAIL: …` if violated; a final `all assertions passed` select confirms
-- success. Everything runs inside one transaction and is rolled back — no data
-- persists.
--
-- Covers the F14 acceptance criteria that live in the database:
--   * an artifact is one row per execution (a re-run updates, never duplicates)
--   * a passing gate cannot carry a failure reason
--   * the stored frame set and checks stay arrays
--   * artifacts are invisible while the round is still accepting stakes
--     (the two-clocks rule), and visible once it is LOCKED

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
-- Fixtures: one published brief, one OPEN round, one locked round, and a
-- generation execution in each — the minimum an artifact needs.
-- ---------------------------------------------------------------------------
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
    -- All five required kinds: the F12 publish trigger refuses a partial set.
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
    case when p_status = 'OPEN' then null else now() end
  ) returning id into v_round;

  return v_round;
end;
$$;

-- A fresh generation execution in a LOCKED round, for tests that need a target
-- row with no artifact yet (so a rejected insert fails on the constraint under
-- test rather than on the one-row-per-execution unique key).
create or replace function pg_temp.make_execution(
  p_model_slug text, p_model_id text, p_openrouter_id text,
  p_status public.round_status default 'LOCKED'
)
returns uuid
language plpgsql
as $$
declare
  v_round uuid := pg_temp.make_round(p_model_slug, p_status);
  v_model uuid;
  v_exec uuid;
begin
  insert into public.llm_models (slug, name, openrouter_model_id)
    values (p_model_slug, 'M', p_model_id) returning id into v_model;

  insert into public.model_executions (round_id, model_id, run_type,
    openrouter_model_id, status)
    values (v_round, v_model, 'generation', p_openrouter_id, 'succeeded')
    returning id into v_exec;

  return v_exec;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. One artifact per execution, and a passing gate carries no failure reason.
-- ---------------------------------------------------------------------------
do $$
declare
  v_exec uuid := pg_temp.make_execution('f14-one', 'f14/one', 'f14/one');
  v_count integer;
begin
  insert into public.rendered_artifacts (execution_id, gate_passed, checks,
    frame_count, frames)
    values (v_exec, true, '[]'::jsonb, 2,
      '[{"index":0,"png":"aa","blank":false,"distinctColors":3,"width":320,"height":240}]'::jsonb);

  -- A second write for the same execution must upsert, not duplicate.
  insert into public.rendered_artifacts (execution_id, gate_passed, checks,
    frame_count, frames)
    values (v_exec, true, '[]'::jsonb, 2, '[]'::jsonb)
    on conflict (execution_id) do update set frames = excluded.frames;

  select count(*) into v_count from public.rendered_artifacts
    where execution_id = v_exec;
  if v_count <> 1 then
    raise exception 'FAIL: expected one artifact per execution, got %', v_count;
  end if;
end $$;

select pg_temp.assert_fails(
  'a passing gate cannot carry a failure reason',
  $sql$insert into public.rendered_artifacts (execution_id, gate_passed, gate_failure_reason)
      values (pg_temp.make_execution('f14-gate', 'f14/gate', 'f14/gate'), true, 'nope')$sql$,
  '23514', '%gate_consistent%');

select pg_temp.assert_fails(
  'checks must be a json array',
  $sql$insert into public.rendered_artifacts (execution_id, gate_passed, checks)
      values (pg_temp.make_execution('f14-checks', 'f14/checks', 'f14/checks'),
        true, '"not an array"'::jsonb)$sql$,
  '23514', '%checks_array%');

-- ---------------------------------------------------------------------------
-- 2. The two-clocks rule: no artifact is visible before LOCKED.
-- ---------------------------------------------------------------------------
do $$
declare
  v_exec_open uuid;
  v_exec_locked uuid;
  v_visible integer;
begin
  v_exec_open := pg_temp.make_execution('f14-clock-a', 'f14/clock-a', 'f14/clock-a', 'OPEN');
  v_exec_locked := pg_temp.make_execution('f14-clock-b', 'f14/clock-b', 'f14/clock-b');

  insert into public.rendered_artifacts (execution_id, gate_passed)
    values (v_exec_open, true), (v_exec_locked, true);

  -- Ask as a client role so RLS applies. Outside the betting window the OPEN
  -- round's artifact must be invisible and the LOCKED one visible.
  set local role authenticated;

  select count(*) into v_visible from public.rendered_artifacts
    where execution_id = v_exec_open;
  if v_visible <> 0 then
    raise exception 'FAIL: an artifact from an OPEN round was readable (%)', v_visible;
  end if;

  select count(*) into v_visible from public.rendered_artifacts
    where execution_id = v_exec_locked;
  if v_visible <> 1 then
    raise exception 'FAIL: a LOCKED round artifact should be readable, got %', v_visible;
  end if;

  reset role;
end $$;

select 'all assertions passed' as result;

rollback;
