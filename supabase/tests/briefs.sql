-- F12 acceptance test — "Seed and validate the visual brief bank."
--
-- How to run: paste this entire script into the hosted Supabase SQL editor
-- (runs as postgres) and execute it in one go. Every assertion raises
-- `FAIL: …` if violated; a final `all assertions passed` select confirms
-- success. Everything runs inside one transaction and is rolled back — no data
-- persists.
--
-- Covers the F12 acceptance criteria:
--   * repeatable, versioned seeding (slug + version; unchanged seed is a no-op)
--   * a brief must be complete to publish (the judge cannot be left guessing)
--   * draft vs published, and a published brief must be renderable
--   * a reference implementation must have rendered before publishing
--   * rounds pin a specific challenge_id (and only a published one)

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
-- A complete, valid brief document, in the shape seed_brief() consumes.
-- Individual tests break one field at a time.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.valid_brief(p_slug text)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'slug', p_slug,
    'title', 'Isometric donut spinning in a loop',
    'prompt', 'An isometric donut rotates once around its vertical axis over one second.',
    'style_constraints', 'Flat shading, two-tone magenta and violet, void background, no text.',
    'entry_point', 'drawFrame',
    'target_duration_ms', 1000,
    'frame_count', 30,
    'frame_width', 320,
    'frame_height', 240,
    'starter_code', 'function drawFrame(t, ctx, canvas) {}',
    'reference_impl', 'function drawFrame(t, ctx, canvas) {}',
    'deterministic_checks', jsonb_build_array(
      jsonb_build_object('kind', 'process_exit', 'expect', 0),
      jsonb_build_object('kind', 'no_uncaught_error'),
      jsonb_build_object('kind', 'frames_emitted', 'expect', 30),
      jsonb_build_object('kind', 'frame_dimensions', 'expect', '320x240'),
      jsonb_build_object('kind', 'non_blank')
    ),
    'judge_rubric', jsonb_build_array(
      jsonb_build_object('id', 'subject', 'question', 'Is the subject a donut?', 'weight', 0.5),
      jsonb_build_object('id', 'motion', 'question', 'Does it spin in a loop?', 'weight', 0.3),
      jsonb_build_object('id', 'style', 'question', 'Does it follow the style constraints?', 'weight', 0.2)
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- 1. Seeding is repeatable and versioned.
-- ---------------------------------------------------------------------------
select pg_temp.assert_ok(
  'seed a new brief',
  $sql$select public.seed_brief(pg_temp.valid_brief('test-isometric-donut'))$sql$);

do $$
declare
  v_version integer;
  v_action text;
  v_status public.challenge_status;
begin
  select version, status into v_version, v_status
    from public.challenges where slug = 'test-isometric-donut';
  if v_version <> 1 then
    raise exception 'FAIL: first seed should be version 1, got %', v_version;
  end if;
  if v_status <> 'draft' then
    raise exception 'FAIL: seeding must not publish, got %', v_status;
  end if;
end $$;

-- An unchanged re-seed is a no-op: same version, no new row.
do $$
declare
  v_version integer;
  v_action text;
  v_count integer;
begin
  select version, action into v_version, v_action
    from public.seed_brief(pg_temp.valid_brief('test-isometric-donut'));
  if v_action <> 'unchanged' or v_version <> 1 then
    raise exception 'FAIL: unchanged re-seed should be v1/unchanged, got v%/s%',
      v_version, v_action;
  end if;
  select count(*) into v_count from public.challenges where slug = 'test-isometric-donut';
  if v_count <> 1 then
    raise exception 'FAIL: unchanged re-seed created % rows', v_count;
  end if;
end $$;

-- A changed document bumps the version and leaves v1 untouched.
do $$
declare
  v_doc jsonb := pg_temp.valid_brief('test-isometric-donut');
  v_version integer;
  v_action text;
begin
  v_doc := jsonb_set(v_doc, '{prompt}', '"An isometric donut rotates twice around its vertical axis."');
  select version, action into v_version, v_action from public.seed_brief(v_doc);
  if v_action <> 'inserted' or v_version <> 2 then
    raise exception 'FAIL: changed re-seed should be v2/inserted, got v%/s%',
      v_version, v_action;
  end if;
end $$;

select pg_temp.assert_fails(
  'the same slug+version cannot be inserted twice',
  $sql$insert into public.challenges (slug, version, title, prompt, language)
      values ('test-isometric-donut', 1, 'Dup', 'Dup.', 'javascript')$sql$,
  '23505');

select pg_temp.assert_fails(
  'seed_brief requires a slug',
  $sql$select public.seed_brief('{}'::jsonb)$sql$,
  '22023');

-- ---------------------------------------------------------------------------
-- 2. An incomplete brief cannot be published.
-- ---------------------------------------------------------------------------
select pg_temp.assert_ok(
  'seed an incomplete brief as a draft',
  $sql$select public.seed_brief(jsonb_build_object(
    'slug', 'incomplete', 'title', 'Incomplete', 'prompt', 'x', 'entry_point', 'drawFrame'))$sql$);

select pg_temp.assert_fails(
  'publishing a brief with no style constraints',
  $sql$select public.publish_brief('incomplete', 1)$sql$,
  '23514');

select pg_temp.assert_fails(
  'publishing a brief with no reference validation',
  $sql$update public.challenges set status = 'published'
      where slug = 'incomplete' and version = 1$sql$,
  '23514');

-- ---------------------------------------------------------------------------
-- 3. Completeness checks are the publish gate, field by field.
-- Each case seeds a fresh slug with one field broken, then attempts to publish.
-- ---------------------------------------------------------------------------
-- No deterministic checks.
select pg_temp.assert_ok('seed brief missing checks',
  $sql$select public.seed_brief(
    jsonb_set(pg_temp.valid_brief('missing-checks'), '{deterministic_checks}', 'null'::jsonb))$sql$);
select pg_temp.assert_fails(
  'publishing without deterministic checks',
  $sql$select public.publish_brief('missing-checks', 1)$sql$,
  '23514', '%deterministic checks%');

-- Checks present but one required kind missing.
select pg_temp.assert_ok('seed brief with a missing check kind',
  $sql$select public.seed_brief(
    jsonb_set(pg_temp.valid_brief('short-checks'), '{deterministic_checks}',
      (pg_temp.valid_brief('x')->'deterministic_checks') - 4))$sql$);
select pg_temp.assert_fails(
  'publishing with an incomplete check set',
  $sql$select public.publish_brief('short-checks', 1)$sql$,
  '23514', '%deterministic checks%');

-- Empty judge rubric.
select pg_temp.assert_ok('seed brief with an empty rubric',
  $sql$select public.seed_brief(
    jsonb_set(pg_temp.valid_brief('empty-rubric'), '{judge_rubric}', '[]'::jsonb))$sql$);
select pg_temp.assert_fails(
  'publishing with an empty judge rubric',
  $sql$select public.publish_brief('empty-rubric', 1)$sql$,
  '23514', '%judge rubric%');

-- Rubric criterion with no question — a judge would have to guess.
select pg_temp.assert_ok('seed brief with a questionless criterion',
  $sql$select public.seed_brief(
    jsonb_set(pg_temp.valid_brief('vague-rubric'), '{judge_rubric}',
      jsonb_build_array(jsonb_build_object('id', 'subject', 'weight', 1))))$sql$);
select pg_temp.assert_fails(
  'publishing with a criterion that has no question',
  $sql$select public.publish_brief('vague-rubric', 1)$sql$,
  '23514', '%judge rubric%');

-- No frame dimensions.
select pg_temp.assert_ok('seed brief with no dimensions',
  $sql$select public.seed_brief(
    jsonb_set(pg_temp.valid_brief('no-dims'), '{frame_width}', 'null'::jsonb))$sql$);
select pg_temp.assert_fails(
  'publishing without frame dimensions',
  $sql$select public.publish_brief('no-dims', 1)$sql$,
  '23514', '%frame dimensions%');

-- No reference implementation.
select pg_temp.assert_ok('seed brief with no reference implementation',
  $sql$select public.seed_brief(
    jsonb_set(pg_temp.valid_brief('no-ref'), '{reference_impl}', '""'::jsonb))$sql$);
select pg_temp.assert_fails(
  'publishing without a reference implementation',
  $sql$select public.publish_brief('no-ref', 1)$sql$,
  '23514', '%reference implementation%');

-- No entry point at all. (An *invalid* one never reaches here: the F13
-- challenges_entry_point_format check rejects it at insert time, which is
-- asserted in constraints.sql.)
select pg_temp.assert_ok('seed brief with no entry point',
  $sql$select public.seed_brief(
    jsonb_set(pg_temp.valid_brief('no-entry'), '{entry_point}', 'null'::jsonb))$sql$);
select pg_temp.assert_fails(
  'publishing without an entry point',
  $sql$select public.publish_brief('no-entry', 1)$sql$,
  '23514', '%entry point%');

-- ---------------------------------------------------------------------------
-- 4. A complete brief publishes; publishing is the only path that stamps the
--    reference validation, and rounds pin a specific challenge_id.
-- ---------------------------------------------------------------------------
select pg_temp.assert_ok(
  'publish a complete brief after its reference render',
  $sql$select public.publish_brief('test-isometric-donut', 2,
    'ai-showdown-render@sha256:0000000000000000000000000000000000000000000000000000000000000000')$sql$);

do $$
declare
  v_status public.challenge_status;
  v_validated timestamptz;
begin
  select status, reference_validated_at into v_status, v_validated
    from public.challenges where slug = 'test-isometric-donut' and version = 2;
  if v_status <> 'published' then
    raise exception 'FAIL: complete brief should be published, got %', v_status;
  end if;
  if v_validated is null then
    raise exception 'FAIL: publish_brief must stamp reference_validated_at';
  end if;
end $$;

select pg_temp.assert_fails(
  'publish_brief refuses a version that is already published',
  $sql$select public.publish_brief('test-isometric-donut', 2)$sql$,
  'P0002');

-- Version 1 of the same slug is still a draft and cannot host a round.
select pg_temp.assert_fails(
  'a draft version cannot be pinned by a round',
  $sql$insert into public.rounds (slug, challenge_id, prediction_deadline)
      values ('r-draft-pin',
        (select id from public.challenges where slug = 'test-isometric-donut' and version = 1),
        now() + interval '1 day')$sql$,
  'P0001', '%cannot be used for a round%');

-- The published version can.
select pg_temp.assert_ok(
  'a round pins a specific published version',
  $sql$insert into public.rounds (slug, challenge_id, prediction_deadline)
      values ('r-pinned',
        (select id from public.challenges where slug = 'test-isometric-donut' and version = 2),
        now() + interval '1 day')$sql$);

-- ---------------------------------------------------------------------------
-- 5. Helper functions agree on what "complete" means.
-- ---------------------------------------------------------------------------
do $$
begin
  if not public.brief_checks_complete(
      pg_temp.valid_brief('x')->'deterministic_checks') then
    raise exception 'FAIL: a full check set should be complete';
  end if;
  if public.brief_checks_complete('[]'::jsonb) then
    raise exception 'FAIL: an empty check set cannot be complete';
  end if;
  if public.brief_checks_complete('null'::jsonb) then
    raise exception 'FAIL: a null check set cannot be complete';
  end if;
  if not public.brief_rubric_complete(pg_temp.valid_brief('x')->'judge_rubric') then
    raise exception 'FAIL: a well-formed rubric should be complete';
  end if;
  if public.brief_rubric_complete('[]'::jsonb) then
    raise exception 'FAIL: an empty rubric cannot be complete';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Pre-pivot python challenges keep their existing rules.
-- ---------------------------------------------------------------------------
select pg_temp.assert_ok(
  'a python challenge still publishes without brief fields',
  $sql$insert into public.challenges (slug, title, prompt, status, entry_point)
      values ('legacy-python', 'Legacy', 'Write code.', 'published', 'solve')$sql$);

select pg_temp.assert_fails(
  'language must be python or javascript',
  $sql$insert into public.challenges (slug, title, prompt, language)
      values ('bad-lang', 'Bad', 'Bad.', 'ruby')$sql$,
  '23514');

-- ---------------------------------------------------------------------------
rollback;

select 'briefs: all assertions passed' as result;
