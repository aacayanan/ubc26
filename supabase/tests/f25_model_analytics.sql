-- F25 acceptance test — historical model performance.
--
-- How to run: paste this entire script into the hosted Supabase SQL editor
-- (runs as postgres) and execute it in one go, or run it locally with
-- `node scripts/db-test.mjs f25`. Every assertion raises `FAIL: …` if violated.
-- Everything runs inside one transaction and is rolled back — no data persists.
--
-- The feature's non-negotiables, as the database can check them:
--
--   * a settled round contributes its conformance status, winner and crowd pick
--     to `model_round_analytics`;
--   * a FAILED or CANCELLED round still appears for every seated model, marked
--     `unsettled` — a failure is labeled, never silently omitted (F25 AC 2);
--   * a void appears marked `voided`;
--   * a Python (retired pre-pivot) round is excluded — not comparable (AC 1);
--   * an undecided round is not history yet and is absent;
--   * `round_history_gaps` lists exactly the comparable rounds without a
--     settled result.
--
-- The rate arithmetic (conformance vs crowd denominators, unavailable-is-not-a-
-- loss) is pure and pinned in `services/models/analytics.test.ts`; this file
-- covers the view that feeds it.

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

create or replace function pg_temp.assert_true(p_desc text, p_condition boolean)
returns void
language plpgsql
as $$
begin
  if not p_condition then
    raise exception 'FAIL: %', p_desc;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: two models, a JavaScript brief (comparable) and a Python challenge
-- (retired pre-pivot, excluded).
-- ---------------------------------------------------------------------------
insert into public.llm_models (slug, name, openrouter_model_id) values
  ('f25-a', 'Model A', 'org/f25-a'),
  ('f25-b', 'Model B', 'org/f25-b')
on conflict (slug) do nothing;

insert into public.challenges (
  slug, version, title, prompt, starter_code, language, status, entry_point,
  style_constraints, target_duration_ms, frame_count, frame_width, frame_height,
  deterministic_checks, judge_rubric, reference_impl, reference_validated_at
) values (
  'f25-brief', 1, 'F25 brief', 'Draw a spinning shape.',
  'function drawFrame(t, ctx, canvas) {}', 'javascript', 'published', 'drawFrame',
  'dark background, one centred shape', 2400, 24, 320, 320,
  jsonb_build_array(
    jsonb_build_object('kind', 'process_exit', 'expect', 0),
    jsonb_build_object('kind', 'no_uncaught_error'),
    jsonb_build_object('kind', 'frames_emitted', 'expect', 24),
    jsonb_build_object('kind', 'frame_dimensions', 'expect', '320x320'),
    jsonb_build_object('kind', 'non_blank')
  ),
  jsonb_build_array(
    jsonb_build_object('id', 'spins', 'question', 'Does it spin?', 'weight', 1)
  ),
  'function drawFrame(t, ctx, canvas) { ctx.fillRect(0, 0, 320, 320); }',
  now()
)
on conflict (slug, version) do nothing;

-- The retired pre-pivot challenge. Published so a round may reference it. The
-- `challenges_published_has_entry_point` constraint applies to every language,
-- so even this Python fixture declares one (the F12 brief-completeness gate
-- itself only fires for JavaScript visual briefs).
insert into public.challenges (
  slug, version, title, prompt, starter_code, language, status, entry_point
) values (
  'f25-python', 1, 'F25 python', 'Solve it.', 'def solve(): pass', 'python',
  'published', 'solve'
)
on conflict (slug, version) do nothing;

/**
 * Create a round and seat both models, then walk it to a terminal status.
 *
 * The lifecycle trigger is stepwise (`CREATED → LOCKED → RUNNING → EVALUATING →
 * SETTLED|VOIDED`), so a terminal status is reached by advancing through it
 * rather than by a direct assignment. This test exercises the analytics view,
 * not the lifecycle (f15/f18 already cover that), so it only walks as far as it
 * needs to.
 */
create or replace function pg_temp.make_round(
  p_slug text,
  p_status public.round_status,
  p_language text default 'javascript'
)
returns uuid
language plpgsql
as $$
declare
  v_challenge uuid;
  v_round uuid;
  v_model_a uuid;
  v_model_b uuid;
  v_target_rank integer;
begin
  select id into v_challenge
    from public.challenges
    where slug = case when p_language = 'python' then 'f25-python' else 'f25-brief' end
      and version = 1;
  select id into v_model_a from public.llm_models where slug = 'f25-a';
  select id into v_model_b from public.llm_models where slug = 'f25-b';

  insert into public.rounds (slug, challenge_id, status, prediction_deadline)
  values (p_slug, v_challenge, 'CREATED', now() + interval '1 day')
  returning id into v_round;

  insert into public.round_models (round_id, model_id, ordinal)
  values (v_round, v_model_a, 1), (v_round, v_model_b, 2);

  -- Walk forward to the requested status along the legal path:
  -- CREATED → OPEN → LOCKED → RUNNING → EVALUATING → SETTLED|VOIDED, with
  -- FAILED reachable from RUNNING and VOIDED/SETTLED only from EVALUATING.
  -- Ranks keep the steps from drifting out of sync with the trigger.
  v_target_rank := case p_status
    when 'CREATED' then 0
    when 'OPEN' then 1
    when 'LOCKED' then 2
    when 'RUNNING' then 3
    -- FAILED branches off RUNNING, so it needs every step up to RUNNING.
    when 'FAILED' then 3
    when 'EVALUATING' then 4
    when 'SETTLED' then 5
    when 'VOIDED' then 5
    else null
  end;

  if v_target_rank is null then
    raise exception 'make_round cannot reach status %', p_status;
  end if;

  if v_target_rank >= 1 then
    update public.rounds set status = 'OPEN' where id = v_round;
  end if;
  if v_target_rank >= 2 then
    update public.rounds set status = 'LOCKED', locked_at = now() where id = v_round;
  end if;
  if v_target_rank >= 3 then
    update public.rounds set status = 'RUNNING', started_at = now() where id = v_round;
  end if;
  if p_status = 'FAILED' then
    update public.rounds set status = 'FAILED' where id = v_round;
    return v_round;
  end if;
  if v_target_rank >= 4 then
    update public.rounds set status = 'EVALUATING' where id = v_round;
  end if;
  if p_status = 'SETTLED' then
    update public.rounds set status = 'SETTLED', settled_at = now() where id = v_round;
  elsif p_status = 'VOIDED' then
    update public.rounds set status = 'VOIDED' where id = v_round;
  end if;

  return v_round;
end;
$$;

-- ---------------------------------------------------------------------------
-- A settled round: A conforms and wins, B does not conform; the crowd picks B.
-- ---------------------------------------------------------------------------
select pg_temp.make_round('f25-settled', 'SETTLED');

insert into public.competition_results (round_id, model_id, category, status, reason)
select r.id, m.id, 'conformance', x.status::public.result_status, x.reason
from public.rounds r
join public.llm_models m on m.slug in ('f25-a', 'f25-b')
join lateral (
  select
    case when m.slug = 'f25-a' then 'conformed' else 'not_conformed' end as status,
    'fixture' as reason
) x on true
where r.slug = 'f25-settled';

insert into public.round_outcomes (round_id, kind, winner_model_id, fan_favorite_model_id, tie_break, reason)
select r.id, 'settled',
       (select id from public.llm_models where slug = 'f25-a'),
       (select id from public.llm_models where slug = 'f25-b'),
       'sole-conformer', 'A was the only model to conform.'
from public.rounds r where r.slug = 'f25-settled';

update public.rounds set settled_at = now() where slug = 'f25-settled';

-- ---------------------------------------------------------------------------
-- A void, a failed round, an undecided round, and a retired Python round.
-- ---------------------------------------------------------------------------
select pg_temp.make_round('f25-void', 'VOIDED');
insert into public.round_outcomes (round_id, kind, tie_break, reason, all_forfeited)
select r.id, 'voided', null, 'Every model forfeited.', true
from public.rounds r where r.slug = 'f25-void';

select pg_temp.make_round('f25-failed', 'FAILED');
select pg_temp.make_round('f25-undecided', 'RUNNING');
select pg_temp.make_round('f25-python', 'SETTLED', 'python');

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_outcome text;
  v_conformance public.result_status;
  v_winner uuid;
  v_crowd uuid;
begin
  -- 1. The settled round yields one row per seated model, with its status.
  select count(*) into v_count
    from public.model_round_analytics a
    join public.rounds r on r.id = a.round_id
    where r.slug = 'f25-settled';
  perform pg_temp.assert_true(
    'a settled round contributes one row per seated model', v_count = 2);

  select a.outcome, a.conformance, a.winner_model_id, a.fan_favorite_model_id
    into v_outcome, v_conformance, v_winner, v_crowd
    from public.model_round_analytics a
    join public.rounds r on r.id = a.round_id
    join public.llm_models m on m.id = a.model_id
    where r.slug = 'f25-settled' and m.slug = 'f25-a';
  perform pg_temp.assert_true('the settled round reads as settled', v_outcome = 'settled');
  perform pg_temp.assert_true('the conforming model carries its conformed status',
    v_conformance = 'conformed');
  perform pg_temp.assert_true('the winner is recorded',
    v_winner = (select id from public.llm_models where slug = 'f25-a'));
  perform pg_temp.assert_true('the crowd pick is recorded',
    v_crowd = (select id from public.llm_models where slug = 'f25-b'));
end;
$$;

do $$
declare
  v_count integer;
  v_outcome text;
begin
  -- 2. A void appears, marked voided — not omitted.
  select count(*) into v_count
    from public.model_round_analytics a
    join public.rounds r on r.id = a.round_id
    where r.slug = 'f25-void';
  perform pg_temp.assert_true('a void still appears for every seated model', v_count = 2);

  select a.outcome into v_outcome
    from public.model_round_analytics a
    join public.rounds r on r.id = a.round_id
    where r.slug = 'f25-void' limit 1;
  perform pg_temp.assert_true('a void reads as voided', v_outcome = 'voided');
end;
$$;

do $$
declare
  v_count integer;
  v_outcome text;
begin
  -- 3. A failed round appears for every seated model, marked unsettled — never
  --    silently dropped (the acceptance criterion this feature exists for).
  select count(*) into v_count
    from public.model_round_analytics a
    join public.rounds r on r.id = a.round_id
    where r.slug = 'f25-failed';
  perform pg_temp.assert_true('a failed round is labeled, not omitted', v_count = 2);

  select a.outcome into v_outcome
    from public.model_round_analytics a
    join public.rounds r on r.id = a.round_id
    where r.slug = 'f25-failed' limit 1;
  perform pg_temp.assert_true('a failed round reads as unsettled', v_outcome = 'unsettled');
end;
$$;

do $$
declare
  v_count integer;
begin
  -- 4. An undecided round is not history yet.
  select count(*) into v_count
    from public.model_round_analytics a
    join public.rounds r on r.id = a.round_id
    where r.slug = 'f25-undecided';
  perform pg_temp.assert_true('an undecided round is absent', v_count = 0);
end;
$$;

do $$
declare
  v_count integer;
begin
  -- 5. The retired Python round is not comparable and is excluded.
  select count(*) into v_count
    from public.model_round_analytics a
    join public.rounds r on r.id = a.round_id
    where r.slug = 'f25-python';
  perform pg_temp.assert_true('a pre-pivot Python round is excluded', v_count = 0);
end;
$$;

do $$
declare
  v_voids integer;
  v_unsettled integer;
begin
  -- 6. round_history_gaps lists exactly the comparable non-settled rounds.
  select count(*) into v_voids
    from public.round_history_gaps g
    where g.round_slug = 'f25-void' and g.outcome = 'voided';
  perform pg_temp.assert_true('the void is listed in history gaps', v_voids = 1);

  select count(*) into v_unsettled
    from public.round_history_gaps g
    where g.round_slug = 'f25-failed' and g.outcome = 'unsettled';
  perform pg_temp.assert_true('the failed round is listed in history gaps', v_unsettled = 1);

  perform pg_temp.assert_true(
    'the settled round is not a gap',
    not exists (select 1 from public.round_history_gaps where round_slug = 'f25-settled'));
  perform pg_temp.assert_true(
    'the undecided round is not a gap',
    not exists (select 1 from public.round_history_gaps where round_slug = 'f25-undecided'));
  perform pg_temp.assert_true(
    'the retired Python round is not a gap',
    not exists (select 1 from public.round_history_gaps where round_slug = 'f25-python'));
end;
$$;

select 'all assertions passed' as result;

rollback;
