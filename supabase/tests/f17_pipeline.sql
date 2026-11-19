-- F17 acceptance test — the chunked generation and render pipeline's schema.
--
-- How to run: paste this entire script into the hosted Supabase SQL editor
-- (runs as postgres) and execute it in one go. Every assertion raises
-- `FAIL: …` if violated; a final `all assertions passed` select confirms
-- success. Everything runs inside one transaction and is rolled back.
--
-- Covers the F17 criteria that live in the database:
--   * a chunk is one row per (execution, chunk_index) — a resume updates,
--     never duplicates, which is what makes "does not re-spend tokens"
--     enforceable rather than aspirational
--   * a preview is one row per (execution, chunk_index), and lives apart from
--     rendered_artifacts so a partial render is never mistaken for evidence
--   * the judge is role-distinct, unique when active, and cannot be seated as
--     a competitor by create_competition
--   * judge rulings are one per subject per round, and are arrays
--   * nothing is visible before the round locks (the two-clocks rule)

begin;

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

-- A published brief + a round in the given status + a generation execution.
create or replace function pg_temp.make_execution(
  p_slug text,
  p_status public.round_status
)
returns uuid
language plpgsql
as $$
declare
  v_challenge uuid;
  v_round uuid;
  v_model uuid;
  v_exec uuid;
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
    case when p_status = 'OPEN' then null else now() end
  ) returning id into v_round;

  insert into public.llm_models (slug, name, openrouter_model_id, role)
    values (p_slug || '-model', 'M', 'test/' || p_slug, 'competitor')
    returning id into v_model;

  insert into public.model_executions (round_id, model_id, run_type,
    openrouter_model_id, status)
    values (v_round, v_model, 'generation', 'test/' || p_slug, 'succeeded')
    returning id into v_exec;

  return v_exec;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. A chunk is unique per (execution, chunk_index).
-- ---------------------------------------------------------------------------
do $$
declare
  v_exec uuid := pg_temp.make_execution('f17-chunk', 'LOCKED');
begin
  insert into public.generation_chunks (execution_id, chunk_index, source,
    prompt_template_version, prompt_sha256)
    values (v_exec, 0, 'function drawFrame() {', 'v1', 'h1');

  -- A resume of the same chunk must pass, not fail.
  perform pg_temp.assert_ok('a resumed chunk updates in place',
    format($q$insert into public.generation_chunks (execution_id, chunk_index,
      source, prompt_template_version, prompt_sha256)
      values (%L, 0, 'function drawFrame() { }', 'v1', 'h1')
      on conflict (execution_id, chunk_index) do update set source = excluded.source$q$,
      v_exec));

  if (select count(*) from public.generation_chunks where execution_id = v_exec) <> 1 then
    raise exception 'FAIL: a resumed chunk duplicated the row';
  end if;

  -- A negative index is not a chunk.
  perform pg_temp.assert_fails('negative chunk index rejected',
    format($q$insert into public.generation_chunks (execution_id, chunk_index,
      source, prompt_template_version, prompt_sha256)
      values (%L, -1, 'x', 'v1', 'h')$q$, v_exec),
    '23514');
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Previews are separate, unique, and keep frames as an array.
-- ---------------------------------------------------------------------------
do $$
declare
  v_exec uuid := pg_temp.make_execution('f17-preview', 'LOCKED');
begin
  insert into public.render_previews (execution_id, chunk_index, parse_ok,
    rendered, frames)
    values (v_exec, 0, false, false, '[]'::jsonb);

  perform pg_temp.assert_ok('a resumed preview updates in place',
    format($q$insert into public.render_previews (execution_id, chunk_index,
      parse_ok, rendered, frames)
      values (%L, 0, true, true, '[]'::jsonb)
      on conflict (execution_id, chunk_index) do update
        set parse_ok = excluded.parse_ok, rendered = excluded.rendered$q$,
      v_exec));

  perform pg_temp.assert_fails('preview frames must be an array',
    format($q$insert into public.render_previews (execution_id, chunk_index,
      parse_ok, frames) values (%L, 5, true, '{}'::jsonb)$q$, v_exec),
    '23514');

  -- A preview is not an artifact: the artifact table stays one-per-execution and
  -- gated, so a partial render can never be read as evidence.
  if exists (select 1 from public.rendered_artifacts where execution_id = v_exec) then
    raise exception 'FAIL: a preview wrote an artifact';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Judges are role-distinct, and at most one is active.
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.assert_fails('an unknown role is rejected',
    $q$insert into public.llm_models (slug, name, openrouter_model_id, role)
       values ('f17-bad-role', 'X', 'test/bad-role', 'referee')$q$,
    '23514');
end;
$$;

-- Distinguish the "two active judges" case from leftover fixtures: a fresh
-- transaction starts with none, so this block seats one, then proves a second
-- is refused.
do $$
begin
  insert into public.llm_models (slug, name, openrouter_model_id, role, is_active)
    values ('f17-judge-1', 'J1', 'test/judge-1', 'judge', true);

  perform pg_temp.assert_fails('a second active judge is rejected',
    $q$insert into public.llm_models (slug, name, openrouter_model_id, role, is_active)
       values ('f17-judge-2', 'J2', 'test/judge-2', 'judge', true)$q$,
    '23505');

  -- Retire it so later sections can seat their own.
  update public.llm_models set is_active = false where slug = 'f17-judge-1';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. A judge cannot be seated as a competitor.
-- ---------------------------------------------------------------------------
do $$
declare
  v_challenge uuid;
  v_comp1 uuid;
  v_comp2 uuid;
  v_judge uuid;
  v_user uuid;
begin
  insert into public.challenges (
    slug, version, title, prompt, language, status, entry_point,
    style_constraints, target_duration_ms, frame_count, frame_width,
    frame_height, deterministic_checks, judge_rubric, reference_impl,
    reference_validated_at
  ) values (
    'f17-comp-brief', 1, 'Donut', 'Draw a donut.', 'javascript', 'published',
    'drawFrame', 'Flat fills.', 1000, 2, 320, 240,
    '[{"kind":"process_exit","expect":0},
      {"kind":"no_uncaught_error"},
      {"kind":"frames_emitted","expect":2},
      {"kind":"frame_dimensions","expect":"320x240"},
      {"kind":"non_blank"}]'::jsonb,
    '[{"id":"subject","question":"Is it a donut?","weight":1}]'::jsonb,
    'function drawFrame() {}', now()
  ) returning id into v_challenge;

  insert into public.llm_models (slug, name, openrouter_model_id, role, is_active)
    values ('f17-comp-a', 'A', 'test/comp-a', 'competitor', true)
    returning id into v_comp1;
  insert into public.llm_models (slug, name, openrouter_model_id, role, is_active)
    values ('f17-comp-b', 'B', 'test/comp-b', 'competitor', true)
    returning id into v_comp2;
  insert into public.llm_models (slug, name, openrouter_model_id, role, is_active)
    values ('f17-judge-seat', 'J', 'test/judge-seat', 'judge', true)
    returning id into v_judge;

  -- A seated, active judge is not a valid competitor even alongside two real
  -- ones: the lineup must never include it.
  perform pg_temp.assert_fails('the judge cannot be a participant',
    format($q$select public.create_competition(
      'f17-judge-seat-round', %L, array[%L, %L, %L]::uuid[],
      now(), now() + interval '1 hour', null)$q$,
      v_challenge, v_comp1, v_comp2, v_judge),
    '22023', '%active competitors%');

  -- Retire this judge so the ruling section can seat its own.
  update public.llm_models set is_active = false where slug = 'f17-judge-seat';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Judge rulings: one per subject per round, criteria is an array.
-- ---------------------------------------------------------------------------
do $$
declare
  v_exec uuid := pg_temp.make_execution('f17-verdict', 'LOCKED');
  v_round uuid;
  v_subject uuid;
  v_judge uuid;
  v_other_exec uuid;
  v_other_subject uuid;
begin
  select e.round_id, e.model_id into v_round, v_subject
    from public.model_executions e where e.id = v_exec;

  insert into public.llm_models (slug, name, openrouter_model_id, role, is_active)
    values ('f17-judge-verdict', 'J', 'test/judge-verdict', 'judge', true)
    returning id into v_judge;

  insert into public.judge_verdicts (execution_id, round_id, subject_model_id,
    verdict, reason, criteria)
    values (v_exec, v_round, v_subject, 'conformed', 'Looks right.', '[]'::jsonb);

  -- The one-ruling-per-subject key refuses a second ruling for the same
  -- subject, which is the order that matters: a re-judge must target the
  -- existing row rather than stack a new one.
  perform pg_temp.assert_fails('a second ruling for the same subject is rejected',
    format($q$insert into public.judge_verdicts (execution_id, round_id,
      subject_model_id, verdict, reason)
      values (%L, %L, %L, 'not_conformed', 'x')$q$, v_exec, v_round, v_subject),
    '23505');

  -- A second subject in the same round is a separate ruling, and needs its own
  -- judge execution because `judge_verdicts.execution_id` is unique.
  insert into public.llm_models (slug, name, openrouter_model_id, role)
    values ('f17-subject-2', 'S2', 'test/subject-2', 'competitor')
    returning id into v_other_subject;

  insert into public.model_executions (round_id, model_id, run_type,
    openrouter_model_id, status, subject_model_id)
    values (v_round, v_judge, 'judge', 'test/judge-verdict', 'succeeded',
            v_other_subject)
    returning id into v_other_exec;

  perform pg_temp.assert_ok('a different subject gets its own ruling',
    format($q$insert into public.judge_verdicts (execution_id, round_id,
      subject_model_id, verdict, reason)
      values (%L, %L, %L, 'not_conformed', 'No ring.')$q$,
      v_other_exec, v_round, v_other_subject));

  if (select count(*) from public.judge_verdicts where round_id = v_round) <> 2 then
    raise exception 'FAIL: the round did not record two rulings';
  end if;

  -- A re-judge replaces the subject's ruling rather than stacking one: the
  -- operator re-judge (F31) targets the existing (round, subject) row, and the
  -- per-criterion weights it stores stay a JSON array the results view reads.
  perform pg_temp.assert_ok('a re-judge updates the existing subject ruling',
    format($q$insert into public.judge_verdicts (execution_id, round_id,
      subject_model_id, verdict, reason, criteria)
      values (%L, %L, %L, 'not_conformed', 'Re-judged.',
        '[{"id":"subject","question":"Is it a donut?","weight":0.6,
           "passed":false,"reason":"Blank."}]'::jsonb)
      on conflict (execution_id) do update set
        verdict = excluded.verdict, reason = excluded.reason,
        criteria = excluded.criteria$q$, v_exec, v_round, v_subject));

  if (select verdict from public.judge_verdicts
        where round_id = v_round and subject_model_id = v_subject) <> 'not_conformed' then
    raise exception 'FAIL: the re-judge did not replace the ruling';
  end if;

  perform pg_temp.assert_fails('verdict criteria must be an array',
    format($q$insert into public.judge_verdicts (execution_id, round_id,
      subject_model_id, verdict, reason, criteria)
      values (%L, %L, %L, 'conformed', 'x', '{}'::jsonb)
      on conflict (execution_id) do update set criteria = excluded.criteria$q$,
      v_exec, v_round, v_subject),
    '23514');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The two clocks: nothing is readable while the round is OPEN.
--
-- RLS is what is under test, not a route's filter, so the reads run as `anon`.
-- Role switching has to happen at statement level: `set local role` inside a
-- `do` block runs in a subtransaction and would abort the enclosing block.
-- ---------------------------------------------------------------------------
create temp table f17_clock_ids as
select pg_temp.make_execution('f17-clocks', 'OPEN') as exec_id;

insert into public.generation_chunks (execution_id, chunk_index, source,
  prompt_template_version, prompt_sha256)
select exec_id, 0, 'function drawFrame() {}', 'v1', 'h' from f17_clock_ids;

-- Capture the counts as anon into a table owned by the superuser afterwards, so
-- the assertions run with normal privileges. The ids are stashed in a psql
-- variable first, because anon cannot read the fixture temp table.
select exec_id as _clock_exec, round_id as _clock_round
  from f17_clock_ids
  join public.model_executions e on e.id = f17_clock_ids.exec_id
\gset

grant select on public.generation_chunks to anon;

set local role anon;
create temp table f17_open_count as
select count(*)::int as hidden from public.generation_chunks
  where execution_id = :'_clock_exec';
reset role;

do $$
declare
  v_hidden integer;
begin
  select hidden into v_hidden from f17_open_count;
  if v_hidden <> 0 then
    raise exception 'FAIL: generation chunks were readable before the round locked';
  end if;
end;
$$;

-- After the lock they become public record.
update public.rounds set status = 'LOCKED', locked_at = now()
  where id = :'_clock_round';

set local role anon;
create temp table f17_locked_count as
select count(*)::int as visible from public.generation_chunks
  where execution_id = :'_clock_exec';
reset role;

do $$
declare
  v_visible integer;
begin
  select visible into v_visible from f17_locked_count;
  if v_visible <> 1 then
    raise exception 'FAIL: generation chunks were not readable after the round locked';
  end if;
end;
$$;

select 'all assertions passed' as result;
rollback;
