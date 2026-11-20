-- SOL wagering (Devnet prototype) — database rules.
--
-- Run with `npm run db:test sol_wagering` (disposable local Postgres) or paste
-- into the SQL editor. Everything is rolled back.
--
-- Covers:
--   * ante window, one ante per (round, user), staff and practice refusal
--   * live wagers need an accepted ante and an open live phase; limits hold
--   * RUNNING opens live betting; close_betting is idempotent and expires
--     unsubmitted wagers; betting phase never moves backwards
--   * EVALUATING, votes and judge verdicts wait for the close
--   * finalize_pool refuses while a wager is in flight, then freezes
--   * record_sol_settlement enforces conservation and is write-once
--   * rule parameters freeze once the round leaves CREATED

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

-- Fixtures ------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-0000-0000-0000000000b1',
   'authenticated', 'authenticated', 'sol-b1@ai-showdown.test', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-0000-0000-0000000000b2',
   'authenticated', 'authenticated', 'sol-b2@ai-showdown.test', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-0000-0000-0000000000b3',
   'authenticated', 'authenticated', 'sol-b3@ai-showdown.test', 'x', now(), '{}', '{}', now(), now());

insert into public.wallets (user_id, address) values
  ('eeeeeeee-0000-0000-0000-0000000000b1', 'WalletB1111111111111111111111111111111111111'),
  ('eeeeeeee-0000-0000-0000-0000000000b2', 'WalletB2222222222222222222222222222222222222'),
  ('eeeeeeee-0000-0000-0000-0000000000b3', 'WalletB3333333333333333333333333333333333333');

update public.users set role = 'admin' where id = 'eeeeeeee-0000-0000-0000-0000000000b3';

insert into public.llm_models (slug, name, openrouter_model_id) values
  ('sol-a', 'Model A', 'org/sol-a'),
  ('sol-b', 'Model B', 'org/sol-b')
on conflict (slug) do nothing;

insert into public.challenges (
  slug, version, title, prompt, starter_code, language, status, entry_point,
  style_constraints, target_duration_ms, frame_count, frame_width, frame_height,
  deterministic_checks, judge_rubric, reference_impl, reference_validated_at
) values (
  'sol-brief', 1, 'SOL brief', 'Draw a spinning shape.',
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

do $$
declare
  v_round uuid;
begin
  insert into public.rounds (slug, challenge_id, status, prediction_deadline,
    wagering_mode, treasury_address, token_budget_per_model, fee_bps)
  values ('sol-round-1',
    (select id from public.challenges where slug = 'sol-brief' and version = 1),
    'CREATED', now() + interval '1 hour',
    'devnet_sol', 'TreasuryXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 6144, 500)
  returning id into v_round;

  insert into public.round_models (round_id, model_id, ordinal) values
    (v_round, (select id from public.llm_models where slug = 'sol-a'), 1),
    (v_round, (select id from public.llm_models where slug = 'sol-b'), 2);

  update public.rounds set status = 'OPEN' where id = v_round;
end;
$$;

create or replace function pg_temp.round_id() returns uuid language sql as $$
  select id from public.rounds where slug = 'sol-round-1'
$$;

create or replace function pg_temp.model(p_slug text) returns uuid language sql as $$
  select id from public.llm_models where slug = p_slug
$$;

-- A prepared wager row as the server's prepare step would insert it.
create or replace function pg_temp.prepare(p_user uuid, p_kind text, p_model text, p_lamports bigint)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.wagers (round_id, user_id, model_id, wallet_address, kind, lamports,
    commitment_hash, commitment_nonce, message_b64, prepared_expires_at)
  values (pg_temp.round_id(), p_user, pg_temp.model(p_model),
    (select address from public.wallets where user_id = p_user),
    p_kind, p_lamports, md5(random()::text), md5(random()::text), 'msg',
    now() + interval '2 minutes')
  returning id into v_id;
  return v_id;
end;
$$;

create temp table t_ids (name text primary key, id uuid);
insert into t_ids values
  ('b1_ante', pg_temp.prepare('eeeeeeee-0000-0000-0000-0000000000b1', 'ante', 'sol-a', 33000000)),
  ('b1_ante_dup', pg_temp.prepare('eeeeeeee-0000-0000-0000-0000000000b1', 'ante', 'sol-b', 33000000)),
  ('b2_ante', pg_temp.prepare('eeeeeeee-0000-0000-0000-0000000000b2', 'ante', 'sol-b', 33000000)),
  ('b3_ante', pg_temp.prepare('eeeeeeee-0000-0000-0000-0000000000b3', 'ante', 'sol-a', 33000000)),
  ('b1_live_early', pg_temp.prepare('eeeeeeee-0000-0000-0000-0000000000b1', 'live', 'sol-b', 10000000));

create or replace function pg_temp.w(p_name text) returns uuid language sql as $$
  select id from t_ids where name = p_name
$$;

-- 1. Ante window ------------------------------------------------------------
select pg_temp.assert_ok('B1 reserves the ante',
  $$select public.wager_reserve(pg_temp.w('b1_ante'), 'sig-b1-ante', 1000)$$);
select pg_temp.assert_ok('re-reserving the same signature is a no-op',
  $$select public.wager_reserve(pg_temp.w('b1_ante'), 'sig-b1-ante', 1000)$$);
select pg_temp.assert_fails('staff cannot wager',
  $$select public.wager_reserve(pg_temp.w('b3_ante'), 'sig-b3-ante', 1000)$$, '42501');
select pg_temp.assert_fails('one in-flight wager per user',
  $$select public.wager_reserve(pg_temp.w('b1_ante_dup'), 'sig-b1-dup', 1000)$$, '22023');
select pg_temp.assert_fails('a live wager needs live betting',
  $$select public.wager_reserve(pg_temp.w('b1_live_early'), 'sig-b1-early', 1000)$$, '22023');

select pg_temp.assert_ok('B1 ante accepted',
  $$select public.wager_resolve(pg_temp.w('b1_ante'), 'accepted', 10, now())$$);
select pg_temp.assert_fails('a second ante is refused',
  $$select public.wager_reserve(pg_temp.w('b1_ante_dup'), 'sig-b1-dup', 1000)$$, '23505');

do $$
begin
  if (select verified_at from public.wallets
      where user_id = 'eeeeeeee-0000-0000-0000-0000000000b1') is null then
    raise exception 'FAIL: an accepted wager should verify the signer wallet';
  end if;
end;
$$;

select pg_temp.assert_ok('B2 reserves the ante',
  $$select public.wager_reserve(pg_temp.w('b2_ante'), 'sig-b2-ante', 1000)$$);
select pg_temp.assert_ok('B2 ante accepted',
  $$select public.wager_resolve(pg_temp.w('b2_ante'), 'accepted', 11, now())$$);

select pg_temp.assert_fails('rules freeze once the round leaves CREATED',
  $$update public.rounds set fee_bps = 900 where id = pg_temp.round_id()$$, 'P0001', '%frozen%');

-- 2. Live window ------------------------------------------------------------
update public.rounds set status = 'LOCKED' where id = pg_temp.round_id();
update public.rounds set status = 'RUNNING' where id = pg_temp.round_id();

do $$
begin
  if (select betting_phase from public.rounds where id = pg_temp.round_id()) <> 'live' then
    raise exception 'FAIL: RUNNING should open live betting';
  end if;
end;
$$;

select pg_temp.assert_fails('a late ante is refused',
  $$select public.wager_reserve(pg_temp.w('b1_ante_dup'), 'sig-b1-dup2', 1000)$$, 'P0001', '%ante window%');

insert into t_ids values
  ('b1_live', pg_temp.prepare('eeeeeeee-0000-0000-0000-0000000000b1', 'live', 'sol-b', 20000000)),
  ('b1_live_big', pg_temp.prepare('eeeeeeee-0000-0000-0000-0000000000b1', 'live', 'sol-b', 300000000)),
  ('b2_live_inflight', pg_temp.prepare('eeeeeeee-0000-0000-0000-0000000000b2', 'live', 'sol-a', 10000000));

select pg_temp.assert_ok('B1 live wager reserved',
  $$select public.wager_reserve(pg_temp.w('b1_live_early'), 'sig-b1-live0', 1000)$$);
select pg_temp.assert_ok('B1 live wager accepted',
  $$select public.wager_resolve(pg_temp.w('b1_live_early'), 'accepted', 12, now())$$);
select pg_temp.assert_ok('B1 second live wager reserved',
  $$select public.wager_reserve(pg_temp.w('b1_live'), 'sig-b1-live1', 1000)$$);
select pg_temp.assert_ok('B1 second live wager accepted',
  $$select public.wager_resolve(pg_temp.w('b1_live'), 'accepted', 13, now())$$);
select pg_temp.assert_fails('a live wager above the cap is refused',
  $$select public.wager_reserve(pg_temp.w('b1_live_big'), 'sig-b1-big', 1000)$$, '22023');

select pg_temp.assert_ok('B2 live wager reserved and left in flight',
  $$select public.wager_reserve(pg_temp.w('b2_live_inflight'), 'sig-b2-live', 1000)$$);

select pg_temp.assert_fails('EVALUATING waits for the close',
  $$update public.rounds set status = 'EVALUATING' where id = pg_temp.round_id()$$, 'P0001');
select pg_temp.assert_fails('votes wait for the close',
  $$insert into public.round_votes (round_id, user_id, model_id)
    values (pg_temp.round_id(), 'eeeeeeee-0000-0000-0000-0000000000b1', pg_temp.model('sol-a'))$$,
  'P0001');

-- 3. Close ------------------------------------------------------------------
select pg_temp.assert_ok('close betting',
  $$select public.close_betting(pg_temp.round_id(), 'token_threshold', pg_temp.model('sol-a'),
      '{"meters": {}}'::jsonb)$$);

do $$
declare
  v jsonb;
begin
  v := public.close_betting(pg_temp.round_id(), 'stall', null, null);
  if not (v->>'alreadyClosed')::boolean or v->>'reason' <> 'token_threshold' then
    raise exception 'FAIL: the first close should win, got %', v;
  end if;
  if (select status from public.wagers where id = pg_temp.w('b1_live_big')) <> 'expired' then
    raise exception 'FAIL: close should expire prepared wagers';
  end if;
end;
$$;

select pg_temp.assert_fails('betting phase cannot reopen',
  $$update public.rounds set betting_phase = 'live' where id = pg_temp.round_id()$$, 'P0001');
select pg_temp.assert_fails('the pool cannot finalize while a wager is in flight',
  $$select public.finalize_pool(pg_temp.round_id())$$, 'P0001', '%confirming%');

-- The in-flight wager (co-signed before the close) lands and counts.
select pg_temp.assert_ok('in-flight wager accepted after the close',
  $$select public.wager_resolve(pg_temp.w('b2_live_inflight'), 'accepted', 14, now())$$);

do $$
declare
  v jsonb;
begin
  v := public.finalize_pool(pg_temp.round_id());
  -- 33M + 33M (antes) + 10M + 20M (B1 live) + 10M (B2 live) = 106M
  if v->>'grossLamports' <> '106000000' or (v->>'acceptedWagers')::int <> 5 then
    raise exception 'FAIL: unexpected final pool %', v;
  end if;
end;
$$;

select pg_temp.assert_fails('the final pool is immutable',
  $$update public.rounds set final_pool = '{}'::jsonb where id = pg_temp.round_id()$$, 'P0001');

update public.rounds set status = 'EVALUATING' where id = pg_temp.round_id();
select pg_temp.assert_ok('votes open after the close',
  $$insert into public.round_votes (round_id, user_id, model_id)
    values (pg_temp.round_id(), 'eeeeeeee-0000-0000-0000-0000000000b1', pg_temp.model('sol-a'))$$);

-- 4. Settlement record ------------------------------------------------------
-- Model B wins. Fee 5% of 106M = 5.3M, net 100.7M split across B backers:
-- B1 30M (10M + 20M) and B2 33M on B → 63M staked on B.
select pg_temp.assert_fails('payouts must conserve the pool',
  $$select public.record_sol_settlement(pg_temp.round_id(), 'settled', 'settled',
      array[pg_temp.model('sol-b')], 5300000,
      jsonb_build_array(
        jsonb_build_object('wager_id', pg_temp.w('b1_ante'), 'outcome', 'lost', 'lamports', 0),
        jsonb_build_object('wager_id', pg_temp.w('b2_ante'), 'outcome', 'won', 'lamports', 52766666),
        jsonb_build_object('wager_id', pg_temp.w('b1_live_early'), 'outcome', 'won', 'lamports', 15985714),
        jsonb_build_object('wager_id', pg_temp.w('b1_live'), 'outcome', 'won', 'lamports', 31971428),
        jsonb_build_object('wager_id', pg_temp.w('b2_live_inflight'), 'outcome', 'lost', 'lamports', 0)),
      jsonb_build_array(
        jsonb_build_object('user_id', 'eeeeeeee-0000-0000-0000-0000000000b1', 'wallet_address', 'w',
          'kind', 'winnings', 'lamports', 1, 'wager_ids', jsonb_build_array(pg_temp.w('b1_live'))))
    )$$, '22023', '%must equal%');

select pg_temp.assert_ok('a conserving settlement is recorded',
  $$select public.record_sol_settlement(pg_temp.round_id(), 'settled', 'settled',
      array[pg_temp.model('sol-b')], 5300000,
      jsonb_build_array(
        jsonb_build_object('wager_id', pg_temp.w('b1_ante'), 'outcome', 'lost', 'lamports', 0),
        jsonb_build_object('wager_id', pg_temp.w('b2_ante'), 'outcome', 'won', 'lamports', 52747619),
        jsonb_build_object('wager_id', pg_temp.w('b1_live_early'), 'outcome', 'won', 'lamports', 15984127),
        jsonb_build_object('wager_id', pg_temp.w('b1_live'), 'outcome', 'won', 'lamports', 31968254),
        jsonb_build_object('wager_id', pg_temp.w('b2_live_inflight'), 'outcome', 'lost', 'lamports', 0)),
      jsonb_build_array(
        jsonb_build_object('user_id', 'eeeeeeee-0000-0000-0000-0000000000b1',
          'wallet_address', 'WalletB1111111111111111111111111111111111111',
          'kind', 'winnings', 'lamports', 47952381,
          'wager_ids', jsonb_build_array(pg_temp.w('b1_live_early'), pg_temp.w('b1_live'))),
        jsonb_build_object('user_id', 'eeeeeeee-0000-0000-0000-0000000000b2',
          'wallet_address', 'WalletB2222222222222222222222222222222222222',
          'kind', 'winnings', 'lamports', 52747619,
          'wager_ids', jsonb_build_array(pg_temp.w('b2_ante'))))
    )$$);

do $$
declare
  v jsonb;
begin
  v := public.record_sol_settlement(pg_temp.round_id(), 'refund', 'again', null, 0, '[]', '[]');
  if not (v->>'alreadyRecorded')::boolean or v->>'kind' <> 'settled' then
    raise exception 'FAIL: a second settlement must return the first, got %', v;
  end if;
  if (select count(*) from public.payouts where round_id = pg_temp.round_id()) <> 2 then
    raise exception 'FAIL: expected exactly two payout rows';
  end if;
  if (select sum(lamports) from public.payouts where round_id = pg_temp.round_id()) <> 100700000 then
    raise exception 'FAIL: payouts should total the net pool';
  end if;
end;
$$;

-- 5. Payout guard -----------------------------------------------------------
update public.payouts set status = 'confirmed', signature = 'payout-sig-1'
  where user_id = 'eeeeeeee-0000-0000-0000-0000000000b2' and round_id = pg_temp.round_id();
select pg_temp.assert_fails('a confirmed payout is final',
  $$update public.payouts set status = 'pending'
    where user_id = 'eeeeeeee-0000-0000-0000-0000000000b2'$$, 'P0001');
select pg_temp.assert_fails('payout amounts are immutable',
  $$update public.payouts set lamports = 1
    where user_id = 'eeeeeeee-0000-0000-0000-0000000000b1'$$, 'P0001');

select 'all assertions passed' as result;
rollback;
