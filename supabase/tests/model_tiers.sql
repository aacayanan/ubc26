-- Model tiers — database rules.
--
-- Run with `npm run db:test model_tiers` (disposable local Postgres) or paste
-- into the SQL editor. Everything is rolled back.
--
-- Covers:
--   * the four rungs exist with their decided buy-ins
--   * create_sol_competition prices a round from its models' tier
--   * a mixed-tier round is refused
--   * an unseated (tier-less) model is refused
--   * a round tier that contradicts the models is refused
--   * the tier is frozen once the round leaves CREATED

begin;

create or replace function pg_temp.assert_ok(p_desc text, p_sql text)
returns void language plpgsql as $$
begin
  execute p_sql;
exception when others then
  raise exception 'FAIL: % — unexpected error [%] %', p_desc, sqlstate, sqlerrm;
end;
$$;

create or replace function pg_temp.assert_fails(p_desc text, p_sql text,
  p_expected_state text, p_msg_pattern text default null)
returns void language plpgsql as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_state := sqlstate;
    v_msg := sqlerrm;
    if v_state = p_expected_state and (p_msg_pattern is null or v_msg like p_msg_pattern) then
      return;
    end if;
    raise exception 'FAIL: % — expected [%] %, got [%] %',
      p_desc, p_expected_state, coalesce(p_msg_pattern, '(any)'), v_state, v_msg;
  end;
  raise exception 'FAIL: % — statement was accepted but should have been rejected', p_desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into public.llm_models (slug, name, openrouter_model_id, tier, role) values
  ('tier-cheap-a', 'Cheap A', 'org/tier-cheap-a', 'cheap', 'competitor'),
  ('tier-cheap-b', 'Cheap B', 'org/tier-cheap-b', 'cheap', 'competitor'),
  ('tier-mid-a',   'Mid A',   'org/tier-mid-a',   'mid',   'competitor'),
  ('tier-mid-b',   'Mid B',   'org/tier-mid-b',   'mid',   'competitor'),
  ('tier-none',    'No Tier', 'org/tier-none',    null,    'competitor')
on conflict (slug) do nothing;

insert into public.challenges (
  slug, version, title, prompt, starter_code, language, status, entry_point,
  style_constraints, target_duration_ms, frame_count, frame_width, frame_height,
  deterministic_checks, judge_rubric, reference_impl, reference_validated_at
) values (
  'tier-brief', 1, 'Tier brief', 'Draw a spinning shape.',
  'function drawFrame(t, ctx, canvas) {}', 'javascript', 'published', 'drawFrame',
  'dark background', 2400, 24, 320, 320,
  jsonb_build_array(
    jsonb_build_object('kind', 'process_exit', 'expect', 0),
    jsonb_build_object('kind', 'no_uncaught_error'),
    jsonb_build_object('kind', 'frames_emitted', 'expect', 24),
    jsonb_build_object('kind', 'frame_dimensions', 'expect', '320x320'),
    jsonb_build_object('kind', 'non_blank')
  ),
  jsonb_build_array(jsonb_build_object('id', 'spins', 'question', 'Does it spin?', 'weight', 1)),
  'function drawFrame(t, ctx, canvas) { ctx.fillRect(0, 0, 320, 320); }',
  now()
)
on conflict (slug, version) do nothing;

create or replace function pg_temp.model(p_slug text) returns uuid language sql as $$
  select id from public.llm_models where slug = p_slug
$$;

create or replace function pg_temp.brief() returns uuid language sql as $$
  select id from public.challenges where slug = 'tier-brief' and version = 1
$$;

-- ---------------------------------------------------------------------------
-- 1. The ladder
-- ---------------------------------------------------------------------------
do $$
declare
  v_cheap integer;
  v_mid integer;
  v_frontier integer;
  v_exclusive integer;
begin
  select ante_usd_cents into v_cheap from public.model_tiers where slug = 'cheap';
  select ante_usd_cents into v_mid from public.model_tiers where slug = 'mid';
  select ante_usd_cents into v_frontier from public.model_tiers where slug = 'frontier';
  select ante_usd_cents into v_exclusive from public.model_tiers where slug = 'exclusive';

  if (v_cheap, v_mid, v_frontier, v_exclusive) is distinct from (200, 400, 600, 1000) then
    raise exception 'FAIL: the tier ladder is %, %, %, % — expected 200, 400, 600, 1000',
      v_cheap, v_mid, v_frontier, v_exclusive;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. A round is priced from its models' tier
-- ---------------------------------------------------------------------------
do $$
declare
  v_round public.rounds;
begin
  select * into v_round from public.create_sol_competition(
    p_slug => 'tier-cheap-round',
    p_challenge_id => pg_temp.brief(),
    p_model_ids => array[pg_temp.model('tier-cheap-a'), pg_temp.model('tier-cheap-b')],
    p_prediction_deadline => now() + interval '1 hour',
    p_created_by => null,
    p_treasury_address => 'TreasuryXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    p_token_budget_per_model => 6144
  );

  if v_round.ante_usd_cents <> 200 then
    raise exception 'FAIL: a cheap round priced the ante at %, expected 200', v_round.ante_usd_cents;
  end if;
  if v_round.tier <> 'cheap' then
    raise exception 'FAIL: the round tier is %, expected cheap', v_round.tier;
  end if;
end;
$$;

-- An explicit tier that matches the models is accepted and still prices from
-- the ladder rather than from the argument.
do $$
declare
  v_round public.rounds;
begin
  select * into v_round from public.create_sol_competition(
    p_slug => 'tier-mid-round',
    p_challenge_id => pg_temp.brief(),
    p_model_ids => array[pg_temp.model('tier-mid-a'), pg_temp.model('tier-mid-b')],
    p_prediction_deadline => now() + interval '1 hour',
    p_created_by => null,
    p_treasury_address => 'TreasuryXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    p_token_budget_per_model => 6144,
    p_tier => 'mid'
  );

  if v_round.ante_usd_cents <> 400 then
    raise exception 'FAIL: a mid round priced the ante at %, expected 400', v_round.ante_usd_cents;
  end if;
end;
$$;

select pg_temp.assert_fails(
  'a mixed-tier round is refused',
  $sql$select public.create_sol_competition(
    p_slug => 'tier-mixed-round',
    p_challenge_id => pg_temp.brief(),
    p_model_ids => array[pg_temp.model('tier-cheap-a'), pg_temp.model('tier-mid-a')],
    p_prediction_deadline => now() + interval '1 hour',
    p_created_by => null,
    p_treasury_address => 'TreasuryXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    p_token_budget_per_model => 6144
  )$sql$,
  '22023', '%one tier%');

select pg_temp.assert_fails(
  'a tier-less model is refused',
  $sql$select public.create_sol_competition(
    p_slug => 'tier-none-round',
    p_challenge_id => pg_temp.brief(),
    p_model_ids => array[pg_temp.model('tier-cheap-a'), pg_temp.model('tier-none')],
    p_prediction_deadline => now() + interval '1 hour',
    p_created_by => null,
    p_treasury_address => 'TreasuryXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    p_token_budget_per_model => 6144
  )$sql$,
  '22023', '%one tier%');

select pg_temp.assert_fails(
  'a contradicting round tier is refused',
  $sql$select public.create_sol_competition(
    p_slug => 'tier-wrong-round',
    p_challenge_id => pg_temp.brief(),
    p_model_ids => array[pg_temp.model('tier-cheap-a'), pg_temp.model('tier-cheap-b')],
    p_prediction_deadline => now() + interval '1 hour',
    p_created_by => null,
    p_treasury_address => 'TreasuryXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    p_token_budget_per_model => 6144,
    p_tier => 'frontier'
  )$sql$,
  '22023', '%does not match%');

-- ---------------------------------------------------------------------------
-- 3. The tier is frozen once the round leaves CREATED
-- ---------------------------------------------------------------------------
select pg_temp.assert_fails(
  'the tier cannot change after the round opens',
  $sql$update public.rounds set tier = 'mid' where slug = 'tier-cheap-round'$sql$,
  'P0001', '%frozen once it leaves CREATED%');

select 'all assertions passed' as result;
rollback;
