-- F18 acceptance test — parimutuel settlement and its idempotency.
--
-- How to run: paste this entire script into the hosted Supabase SQL editor
-- (runs as postgres) and execute it in one go. Every assertion raises
-- `FAIL: …` if violated; a final `all assertions passed` select confirms
-- success. Everything runs inside one transaction and is rolled back — no data
-- persists.
--
-- Conventions this file follows (see f15_outcomes.sql / f17_pipeline.sql):
--   * the RPCs under test are `security definer` and identify the caller with
--     `auth.uid()`, so the caller is simulated by setting `request.jwt.claim.sub`
--     at STATEMENT level (not inside the assertion's `execute`, which runs in a
--     subtransaction). This exercises the RPC's own rules — the join gate, the
--     window, the balance — rather than RLS, which `rls.sql` already covers.
--   * rounds are looked up by slug so no temp-table visibility is assumed.
--
-- Covers the F18 acceptance criteria that live in the database:
--   * a stake after the deadline is rejected, an over-balance stake is rejected,
--     and a duplicate stake updates the existing row rather than adding a second
--   * a vote before LOCKED is rejected; a second vote is a change; a vote for a
--     non-participating model is rejected
--   * `settle_round` conserves the pot, writes one score event per staker
--     (including the zero-point losers) and credits balances with the streak rule
--   * a second `settle_round` call is a no-op (`alreadySettled`), never a double-pay
--   * a void settles every stake as void with zero points
--   * a round cannot reach SETTLED while a conformance stake is unsettled
--   * a finalized round refuses further score_events writes

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

-- Simulate "the caller" for the security-definer RPCs. `set_config(..., true)`
-- is transaction-scoped, so it lasts until this script's `rollback`. Statement
-- level on purpose: the setting must be visible inside the assertion's `execute`.
create or replace function pg_temp.as_user(p_uid uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text,
    true
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: three accounts (two funded stakers, one unfunded), two models,
-- one published brief.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000',
   'ffffffff-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated',
   'f18-a1@ai-showdown.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000',
   'ffffffff-0000-0000-0000-0000000000a2', 'authenticated', 'authenticated',
   'f18-a2@ai-showdown.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000',
   'ffffffff-0000-0000-0000-0000000000a3', 'authenticated', 'authenticated',
   'f18-a3@ai-showdown.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- The children of auth.users (users, user_scores) are created by the signup
-- trigger; set the funded/practice columns the RPCs read.
update public.users set display_name = 'Staker A1', funded = true
  where id = 'ffffffff-0000-0000-0000-0000000000a1';
update public.users set display_name = 'Staker A2', funded = true
  where id = 'ffffffff-0000-0000-0000-0000000000a2';
update public.users set display_name = 'Unfunded A3', funded = false
  where id = 'ffffffff-0000-0000-0000-0000000000a3';

insert into public.llm_models (slug, name, openrouter_model_id) values
  ('f18-a', 'Model A', 'org/f18-a'),
  ('f18-b', 'Model B', 'org/f18-b'),
  -- In no round: the subject of the "vote for a non-participating model" check.
  ('f18-c', 'Model C', 'org/f18-c')
on conflict (slug) do nothing;

-- A published JavaScript brief. The publish gate (F12) requires a complete
-- deterministic-check set, a rubric, and a validated reference render, so the
-- fixture supplies all of them rather than inserting a bare row.
insert into public.challenges (
  slug, version, title, prompt, starter_code, language, status, entry_point,
  style_constraints, target_duration_ms, frame_count, frame_width, frame_height,
  deterministic_checks, judge_rubric, reference_impl, reference_validated_at
) values (
  'f18-brief', 1, 'F18 brief', 'Draw a spinning shape.',
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
    jsonb_build_object(
      'id', 'spins',
      'question', 'Does the shape spin across the loop?',
      'weight', 1
    )
  ),
  'function drawFrame(t, ctx, canvas) { ctx.fillRect(0, 0, 320, 320); }',
  now()
)
on conflict (slug, version) do nothing;

create or replace function pg_temp.make_round(p_slug text, p_status public.round_status)
returns uuid
language plpgsql
as $$
declare
  v_challenge uuid;
  v_round uuid;
  v_model_a uuid;
  v_model_b uuid;
begin
  select id into v_challenge from public.challenges where slug = 'f18-brief' and version = 1;
  select id into v_model_a from public.llm_models where slug = 'f18-a';
  select id into v_model_b from public.llm_models where slug = 'f18-b';

  insert into public.rounds (slug, challenge_id, status, prediction_deadline)
  values (p_slug, v_challenge, 'CREATED', now() + interval '1 day')
  returning id into v_round;

  insert into public.round_models (round_id, model_id, ordinal)
  values (v_round, v_model_a, 1), (v_round, v_model_b, 2);

  update public.rounds set status = p_status where id = v_round;
  return v_round;
end;
$$;

select pg_temp.make_round('f18-round-1', 'OPEN');
select pg_temp.make_round('f18-round-2', 'OPEN');

-- ---------------------------------------------------------------------------
-- 1. Starter grant: a new account has a balance to stake from.
-- ---------------------------------------------------------------------------
do $$
declare
  v_points integer;
begin
  select total_points into v_points
    from public.user_scores
    where user_id = 'ffffffff-0000-0000-0000-0000000000a1';
  if v_points < 10 then
    raise exception 'FAIL: a new account should carry a starter grant, found %', v_points;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Placing stakes: the join gate, the balance check and the deadline.
-- ---------------------------------------------------------------------------
-- A3 is unfunded and must not be able to stake (the RPC raises 42501).
select pg_temp.as_user('ffffffff-0000-0000-0000-0000000000a3');
select pg_temp.assert_fails(
  'an unfunded account cannot stake',
  $sql$select public.place_stake(
        (select id from public.rounds where slug = 'f18-round-1'),
        (select id from public.llm_models where slug = 'f18-a'),
        100)$sql$,
  '42501',
  '%link a wallet%'
);

-- A1 places a valid stake on model A.
select pg_temp.as_user('ffffffff-0000-0000-0000-0000000000a1');
select pg_temp.assert_ok(
  'a funded account stakes on a participating model',
  $sql$select public.place_stake(
        (select id from public.rounds where slug = 'f18-round-1'),
        (select id from public.llm_models where slug = 'f18-a'),
        100)$sql$
);

-- A1 stakes again: same round, so it is an update, not a second row.
select pg_temp.assert_ok(
  'a second stake updates the existing row',
  $sql$select public.place_stake(
        (select id from public.rounds where slug = 'f18-round-1'),
        (select id from public.llm_models where slug = 'f18-a'),
        100)$sql$
);

do $$
declare
  v_count integer;
  v_points integer;
begin
  select count(*), max(stake_points) into v_count, v_points
    from public.predictions
    where round_id = (select id from public.rounds where slug = 'f18-round-1')
      and user_id = 'ffffffff-0000-0000-0000-0000000000a1';
  if v_count <> 1 then
    raise exception 'FAIL: expected one stake row, found %', v_count;
  end if;
  if v_points <> 100 then
    raise exception 'FAIL: expected 100 staked, found %', v_points;
  end if;
end;
$$;

-- An over-balance stake is rejected.
select pg_temp.assert_fails(
  'an over-balance stake is rejected',
  $sql$select public.place_stake(
        (select id from public.rounds where slug = 'f18-round-1'),
        (select id from public.llm_models where slug = 'f18-a'),
        1000000)$sql$,
  '22003'
);

-- A2 stakes on model B so the pool has a loser.
select pg_temp.as_user('ffffffff-0000-0000-0000-0000000000a2');
select pg_temp.assert_ok(
  'a second funded account stakes on the other model',
  $sql$select public.place_stake(
        (select id from public.rounds where slug = 'f18-round-1'),
        (select id from public.llm_models where slug = 'f18-b'),
        50)$sql$
);

-- A stake after the deadline is rejected even though the round is still OPEN.
update public.rounds set prediction_deadline = now() - interval '1 minute'
  where slug = 'f18-round-1';

select pg_temp.as_user('ffffffff-0000-0000-0000-0000000000a2');
select pg_temp.assert_fails(
  'a stake after the deadline is rejected',
  $sql$select public.place_stake(
        (select id from public.rounds where slug = 'f18-round-1'),
        (select id from public.llm_models where slug = 'f18-b'),
        10)$sql$,
  'P0001',
  '%deadline%'
);

-- Restore the deadline so later sections behave.
update public.rounds set prediction_deadline = now() + interval '1 day'
  where slug = 'f18-round-1';

-- ---------------------------------------------------------------------------
-- 3. Voting: only after the betting window closes, one vote per account.
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ffffffff-0000-0000-0000-0000000000a2');
select pg_temp.assert_fails(
  'a vote before the round locks is rejected',
  $sql$select public.cast_vote(
        (select id from public.rounds where slug = 'f18-round-1'),
        (select id from public.llm_models where slug = 'f18-a'))$sql$,
  'P0001',
  '%vote is not open%'
);

update public.rounds set status = 'LOCKED', locked_at = now()
  where slug = 'f18-round-1';

select pg_temp.assert_ok(
  'a vote after the round locks is accepted',
  $sql$select public.cast_vote(
        (select id from public.rounds where slug = 'f18-round-1'),
        (select id from public.llm_models where slug = 'f18-b'))$sql$
);

select pg_temp.assert_ok(
  'a second vote changes the pick rather than stacking',
  $sql$select public.cast_vote(
        (select id from public.rounds where slug = 'f18-round-1'),
        (select id from public.llm_models where slug = 'f18-a'))$sql$
);

-- A vote for a model that is not in the round is rejected.
select pg_temp.assert_fails(
  'a vote for a non-participating model is rejected',
  $sql$select public.cast_vote(
        (select id from public.rounds where slug = 'f18-round-2'),
        (select id from public.llm_models where slug = 'f18-c'))$sql$,
  '22023'
);

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.round_votes
    where round_id = (select id from public.rounds where slug = 'f18-round-1')
      and user_id = 'ffffffff-0000-0000-0000-0000000000a2';
  if v_count <> 1 then
    raise exception 'FAIL: expected one vote row, found %', v_count;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. A round cannot finalize while a conformance stake is open.
-- ---------------------------------------------------------------------------
update public.rounds set status = 'RUNNING' where slug = 'f18-round-1';
update public.rounds set status = 'EVALUATING' where slug = 'f18-round-1';

select pg_temp.assert_fails(
  'a round cannot settle with an unsettled stake',
  $sql$update public.rounds set status = 'SETTLED'
      where slug = 'f18-round-1'$sql$,
  'P0001',
  '%unsettled stake%'
);

-- ---------------------------------------------------------------------------
-- 5. settle_round: the pot is conserved and idempotent.
--
-- Pot = 100 (A1 on A, the winner) + 50 (A2 on B) = 150. A1's exact share is
-- 100/100*150 = 150; A2 loses and gets only the 25-point fan-favorite award.
-- ---------------------------------------------------------------------------
select public.settle_round(
  (select id from public.rounds where slug = 'f18-round-1'),
  'settled',
  (select id from public.llm_models where slug = 'f18-a'),
  (select id from public.llm_models where slug = 'f18-a'),
  'sole-conformer',
  'Model A was the only model to conform.',
  false,
  jsonb_build_array(
    jsonb_build_object(
      'model_id', (select id from public.llm_models where slug = 'f18-a'),
      'status', 'conformed', 'reason', 'conformant'),
    jsonb_build_object(
      'model_id', (select id from public.llm_models where slug = 'f18-b'),
      'status', 'not_conformed', 'reason', 'off brief')
  ),
  jsonb_build_array(
    jsonb_build_object(
      'prediction_id',
      (select id from public.predictions
        where round_id = (select id from public.rounds where slug = 'f18-round-1')
          and user_id = 'ffffffff-0000-0000-0000-0000000000a1'),
      'user_id', 'ffffffff-0000-0000-0000-0000000000a1',
      'outcome', 'won', 'points_awarded', 150),
    jsonb_build_object(
      'prediction_id',
      (select id from public.predictions
        where round_id = (select id from public.rounds where slug = 'f18-round-1')
          and user_id = 'ffffffff-0000-0000-0000-0000000000a2'),
      'user_id', 'ffffffff-0000-0000-0000-0000000000a2',
      'outcome', 'lost', 'points_awarded', 0)
  ),
  jsonb_build_array(
    jsonb_build_object('user_id', 'ffffffff-0000-0000-0000-0000000000a2', 'points', 25)
  )
);

do $$
declare
  v_status public.round_status;
  v_pot integer;
  v_unsettled integer;
  v_a1 integer;
  v_a2 integer;
  v_a1_streak integer;
  v_a2_streak integer;
begin
  select status into v_status from public.rounds where slug = 'f18-round-1';
  if v_status <> 'SETTLED' then
    raise exception 'FAIL: round should be SETTLED, is %', v_status;
  end if;

  -- Pot conserved: the stake events total the pot (150).
  select coalesce(sum(points), 0) into v_pot
    from public.score_events
    where round_id = (select id from public.rounds where slug = 'f18-round-1')
      and kind = 'stake';
  if v_pot <> 150 then
    raise exception 'FAIL: stake events should total the 150 pot, total %', v_pot;
  end if;

  -- Every stake is settled (the zero-point loser included).
  select count(*) into v_unsettled
    from public.predictions
    where round_id = (select id from public.rounds where slug = 'f18-round-1')
      and settled_at is null;
  if v_unsettled <> 0 then
    raise exception 'FAIL: % stake(s) left unsettled', v_unsettled;
  end if;

  select total_points, current_streak into v_a1, v_a1_streak
    from public.user_scores where user_id = 'ffffffff-0000-0000-0000-0000000000a1';
  select total_points, current_streak into v_a2, v_a2_streak
    from public.user_scores where user_id = 'ffffffff-0000-0000-0000-0000000000a2';

  -- A1: starter 1000 + 150 won. Streak: won -> 1.
  if v_a1 <> 1150 then
    raise exception 'FAIL: A1 should hold 1150, holds %', v_a1;
  end if;
  if v_a1_streak <> 1 then
    raise exception 'FAIL: A1 streak should be 1, is %', v_a1_streak;
  end if;

  -- A2: starter 1000 + 25 fan-favorite (stake returned 0). Streak: lost -> 0.
  if v_a2 <> 1025 then
    raise exception 'FAIL: A2 should hold 1025, has %', v_a2;
  end if;
  if v_a2_streak <> 0 then
    raise exception 'FAIL: A2 streak should be 0 after a loss, is %', v_a2_streak;
  end if;
end;
$$;

-- A second settle is a no-op: the latch reports alreadySettled and pays nobody.
do $$
declare
  v_result jsonb;
  v_a1 integer;
begin
  v_result := public.settle_round(
    (select id from public.rounds where slug = 'f18-round-1'),
    'settled',
    (select id from public.llm_models where slug = 'f18-a'),
    null, 'sole-conformer', 'retry', false, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
  );

  if (v_result->>'alreadySettled')::boolean is distinct from true then
    raise exception 'FAIL: a second settle should report alreadySettled, got %', v_result;
  end if;

  select total_points into v_a1
    from public.user_scores where user_id = 'ffffffff-0000-0000-0000-0000000000a1';
  if v_a1 <> 1150 then
    raise exception 'FAIL: a retry must not double-pay; A1 holds %', v_a1;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. A void returns every stake and pays no one from the pool.
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ffffffff-0000-0000-0000-0000000000a1');
select pg_temp.assert_ok(
  'a stake is placed on the voidable round',
  $sql$select public.place_stake(
        (select id from public.rounds where slug = 'f18-round-2'),
        (select id from public.llm_models where slug = 'f18-b'),
        40)$sql$
);

update public.rounds set status = 'LOCKED' where slug = 'f18-round-2';
update public.rounds set status = 'RUNNING' where slug = 'f18-round-2';
update public.rounds set status = 'EVALUATING' where slug = 'f18-round-2';

select public.settle_round(
  (select id from public.rounds where slug = 'f18-round-2'),
  'voided',
  null, null, null,
  'No model conformed to the brief, so the round is void.',
  true,
  jsonb_build_array(
    jsonb_build_object(
      'model_id', (select id from public.llm_models where slug = 'f18-a'),
      'status', 'forfeited', 'reason', 'render error'),
    jsonb_build_object(
      'model_id', (select id from public.llm_models where slug = 'f18-b'),
      'status', 'forfeited', 'reason', 'render error')
  ),
  jsonb_build_array(
    jsonb_build_object(
      'prediction_id',
      (select id from public.predictions
        where round_id = (select id from public.rounds where slug = 'f18-round-2')
          and user_id = 'ffffffff-0000-0000-0000-0000000000a1'),
      'user_id', 'ffffffff-0000-0000-0000-0000000000a1',
      'outcome', 'void', 'points_awarded', 0)
  ),
  '[]'::jsonb
);

do $$
declare
  v_status public.round_status;
  v_outcome text;
  v_awarded integer;
  v_points integer;
  v_credited integer;
begin
  select status into v_status from public.rounds where slug = 'f18-round-2';
  if v_status <> 'VOIDED' then
    raise exception 'FAIL: voided round should be VOIDED, is %', v_status;
  end if;

  select settlement_outcome, points_awarded into v_outcome, v_awarded
    from public.predictions
    where round_id = (select id from public.rounds where slug = 'f18-round-2')
      and user_id = 'ffffffff-0000-0000-0000-0000000000a1';
  if v_outcome <> 'void' or v_awarded <> 0 then
    raise exception 'FAIL: a void stake should be void/0, is %/%', v_outcome, v_awarded;
  end if;

  -- No pool points were minted on a void.
  select coalesce(sum(points), 0) into v_credited
    from public.score_events
    where round_id = (select id from public.rounds where slug = 'f18-round-2')
      and kind = 'stake';
  if v_credited <> 0 then
    raise exception 'FAIL: a void should credit no pool points, credited %', v_credited;
  end if;

  -- A1 keeps the balance from round 1; a void refunds nothing because the stake
  -- was never debited.
  select total_points into v_points
    from public.user_scores where user_id = 'ffffffff-0000-0000-0000-0000000000a1';
  if v_points <> 1150 then
    raise exception 'FAIL: A1 balance should be unchanged by a void, is %', v_points;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. A finalized round refuses further ledger writes.
-- ---------------------------------------------------------------------------
select pg_temp.assert_fails(
  'a finalized round refuses a new score event',
  $sql$insert into public.score_events (round_id, user_id, points)
      values ((select id from public.rounds where slug = 'f18-round-1'),
              'ffffffff-0000-0000-0000-0000000000a1', 5)$sql$,
  'P0001',
  '%finalized round%'
);

select 'all assertions passed' as result;
rollback;
