-- F2 acceptance test — "RLS protects user-owned data while allowing required
-- public competition/results reads."
--
-- How to run: paste this entire script into the hosted Supabase SQL editor
-- (runs as postgres) and execute it in one go. It switches roles with
-- `set local role` and fakes JWT claims so auth.uid() resolves, asserting
-- what each role can and cannot see/do. Any violation raises `FAIL: …`;
-- a final `all assertions passed` select confirms success. Everything is
-- rolled back — no data persists.
--
-- Note: if your editor splits statements across transactions, replace
-- `set local` with plain `set` (the session ends after the script anyway).

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000001',
   'authenticated', 'authenticated', 'alice@ai-showdown.test', 'not-a-real-hash',
   now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000002',
   'authenticated', 'authenticated', 'bob@ai-showdown.test', 'not-a-real-hash',
   now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- The F8 signup trigger (handle_new_user) already inserted a profile for each
-- auth.users row above, so this is an upsert: it sets display_name without
-- tripping the primary key.
insert into public.users (id, display_name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Alice'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Bob')
on conflict (id) do update set display_name = excluded.display_name;

insert into public.llm_models (slug, name, openrouter_model_id) values
  ('model-a', 'Model A', 'org/model-a'),
  ('model-b', 'Model B', 'org/model-b');

insert into public.challenges (slug, title, prompt, status, entry_point) values
  ('c-pub', 'Published challenge', 'Write code.', 'published', 'solve'),
  ('c-draft', 'Draft challenge', 'Work in progress.', 'draft', null);

insert into public.test_cases (challenge_id, kind, ordinal, expected_output) values
  ((select id from public.challenges where slug = 'c-pub'), 'public', 1, 'ok'),
  ((select id from public.challenges where slug = 'c-pub'), 'hidden', 2, 'secret');

insert into public.rounds (slug, challenge_id, prediction_deadline) values
  ('r-main', (select id from public.challenges where slug = 'c-pub'), now() + interval '1 day');

update public.rounds set status = 'OPEN' where slug = 'r-main';

insert into public.round_models (round_id, model_id)
select r.id, m.id
from public.rounds r
cross join public.llm_models m
where r.slug = 'r-main' and m.slug in ('model-a', 'model-b');

insert into public.predictions (round_id, user_id, category, model_id) values (
  (select id from public.rounds where slug = 'r-main'),
  'aaaaaaaa-0000-0000-0000-000000000001',
  'accuracy',
  (select id from public.llm_models where slug = 'model-a'));

insert into public.predictions (round_id, user_id, category, model_id) values (
  (select id from public.rounds where slug = 'r-main'),
  'aaaaaaaa-0000-0000-0000-000000000002',
  'accuracy',
  (select id from public.llm_models where slug = 'model-a'));

insert into public.wallets (user_id, address) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'AliceWalletAddress111'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'BobWalletAddress222');

insert into public.blockchain_transactions (idempotency_key, signature, purpose, status, user_id) values
  ('tx-key-a', 'sig-a', 'prediction_commitment', 'confirmed', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('tx-key-b', 'sig-b', 'prediction_commitment', 'confirmed', 'aaaaaaaa-0000-0000-0000-000000000002');

-- The signup trigger also created a user_scores row per account (F6/F18), so
-- upsert rather than insert.
insert into public.user_scores (user_id, total_points) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 100),
  ('aaaaaaaa-0000-0000-0000-000000000002', 50)
on conflict (user_id) do update set total_points = excluded.total_points;

insert into public.competition_results (round_id, model_id, category, status, placement, metric_value)
select (select id from public.rounds where slug = 'r-main'),
       (select id from public.llm_models where slug = 'model-a'),
       'accuracy', 'qualified', 1, 10;

insert into public.score_events (round_id, user_id, points) values
  ((select id from public.rounds where slug = 'r-main'),
   'aaaaaaaa-0000-0000-0000-000000000002', 5);

insert into public.model_executions (round_id, model_id, run_type, openrouter_model_id, status)
select (select id from public.rounds where slug = 'r-main'),
       (select id from public.llm_models where slug = 'model-a'),
       'generation', 'org/model-a', 'succeeded';

insert into public.test_results (execution_id, test_case_id, passed)
select (select id from public.model_executions limit 1),
       (select id from public.test_cases where ordinal = 1 limit 1),
       true;

-- ---------------------------------------------------------------------------
-- anon: public competition/results reads; zero user-owned data; only
-- published challenges and public test cases.
-- ---------------------------------------------------------------------------
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
set local request.jwt.claim.sub to '';

do $$
declare
  n int;
begin
  select count(*) into n from public.rounds;
  if n < 1 then raise exception 'FAIL: anon cannot read rounds'; end if;

  select count(*) into n from public.competition_results;
  if n < 1 then raise exception 'FAIL: anon cannot read competition_results'; end if;

  select count(*) into n from public.user_scores;
  if n < 1 then raise exception 'FAIL: anon cannot read user_scores (leaderboard)'; end if;

  select count(*) into n from public.score_events;
  if n < 1 then raise exception 'FAIL: anon cannot read score_events'; end if;

  select count(*) into n from public.llm_models;
  if n < 1 then raise exception 'FAIL: anon cannot read llm_models'; end if;

  -- F27: an execution row is readable only once its round is past OPEN, because
  -- it carries the model's source and the provider's error text. The fixture
  -- round is OPEN, so the honest assertion is that anon sees none of it.
  select count(*) into n from public.model_executions;
  if n <> 0 then
    raise exception 'FAIL: anon can read model_executions before the round locks (%)', n;
  end if;

  select count(*) into n from public.test_results;
  if n < 1 then raise exception 'FAIL: anon cannot read test_results'; end if;

  select count(*) into n from public.users;
  if n < 2 then raise exception 'FAIL: anon cannot read user profiles'; end if;

  select count(*) into n from public.predictions;
  if n <> 0 then raise exception 'FAIL: anon can read predictions (%)', n; end if;

  select count(*) into n from public.wallets;
  if n <> 0 then raise exception 'FAIL: anon can read wallets (%)', n; end if;

  select count(*) into n from public.blockchain_transactions;
  if n <> 0 then raise exception 'FAIL: anon can read blockchain_transactions (%)', n; end if;

  -- Assert about this fixture's own rows, not a global count: later migrations
  -- (F8's demo catalog) also insert published challenges.
  select count(*) into n from public.challenges where slug = 'c-draft';
  if n <> 0 then raise exception 'FAIL: anon can read a draft challenge'; end if;

  select count(*) into n from public.challenges where slug = 'c-pub';
  if n <> 1 then raise exception 'FAIL: anon cannot read a published challenge'; end if;

  select count(*) into n from public.test_cases;
  if n < 1 then raise exception 'FAIL: anon cannot read public test cases'; end if;

  select count(*) into n from public.test_cases where kind = 'hidden';
  if n <> 0 then raise exception 'FAIL: anon can read a hidden test case'; end if;
end $$;

-- anon has no insert privilege on predictions (revoked in the RLS migration).
do $$
begin
  begin
    insert into public.predictions (round_id, user_id, category, model_id)
    values ((select id from public.rounds where slug = 'r-main'),
            'aaaaaaaa-0000-0000-0000-000000000001', 'speed',
            (select id from public.llm_models where slug = 'model-b'));
    raise exception 'FAIL: anon insert into predictions was accepted';
  exception when others then
    if sqlstate = 'P0001' and sqlerrm like 'FAIL:%' then raise; end if;
    if sqlstate <> '42501' then
      raise exception 'FAIL: anon insert expected 42501, got [%] %', sqlstate, sqlerrm;
    end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- authenticated as Alice: own rows only; cannot touch Bob's data or
-- privileged columns; can submit and edit her own pick while OPEN.
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';
set local request.jwt.claim.sub to 'aaaaaaaa-0000-0000-0000-000000000001';

do $$
declare
  n int;
begin
  select count(*) into n from public.predictions;
  if n <> 1 then raise exception 'FAIL: authenticated should see exactly own predictions, got %', n; end if;

  select count(*) into n from public.wallets;
  if n <> 1 then raise exception 'FAIL: authenticated should see only own wallet, got %', n; end if;

  select count(*) into n from public.blockchain_transactions;
  if n <> 1 then raise exception 'FAIL: authenticated should see only own transactions, got %', n; end if;

  select count(*) into n from public.users;
  if n < 2 then raise exception 'FAIL: authenticated cannot read user profiles'; end if;

  select count(*) into n from public.rounds;
  if n < 1 then raise exception 'FAIL: authenticated cannot read rounds'; end if;
end $$;

-- Inserting a pick for another user violates the WITH CHECK policy.
do $$
begin
  begin
    insert into public.predictions (round_id, user_id, category, model_id)
    values ((select id from public.rounds where slug = 'r-main'),
            'aaaaaaaa-0000-0000-0000-000000000002', 'speed',
            (select id from public.llm_models where slug = 'model-b'));
    raise exception 'FAIL: insert with another user_id was accepted';
  exception when others then
    if sqlstate = 'P0001' and sqlerrm like 'FAIL:%' then raise; end if;
    if sqlstate <> '42501' then
      raise exception 'FAIL: cross-user insert expected 42501, got [%] %', sqlstate, sqlerrm;
    end if;
  end;
end $$;

-- points_awarded is not in the column grant — clients cannot self-award.
do $$
begin
  begin
    update public.predictions set points_awarded = 9999
      where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
    raise exception 'FAIL: client could set points_awarded';
  exception when others then
    if sqlstate = 'P0001' and sqlerrm like 'FAIL:%' then raise; end if;
    if sqlstate <> '42501' then
      raise exception 'FAIL: points_awarded update expected 42501, got [%] %', sqlstate, sqlerrm;
    end if;
  end;
end $$;

-- role is not in the column grant — no privilege escalation.
do $$
begin
  begin
    update public.users set role = 'admin'
      where id = 'aaaaaaaa-0000-0000-0000-000000000001';
    raise exception 'FAIL: client could escalate own role to admin';
  exception when others then
    if sqlstate = 'P0001' and sqlerrm like 'FAIL:%' then raise; end if;
    if sqlstate <> '42501' then
      raise exception 'FAIL: role update expected 42501, got [%] %', sqlstate, sqlerrm;
    end if;
  end;
end $$;

-- Updates scoped to another user's rows silently affect 0 rows (RLS USING).
do $$
declare
  n int;
begin
  update public.predictions set model_id = (select id from public.llm_models where slug = 'model-b')
    where user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: authenticated updated Bob''s prediction (%)', n; end if;

  update public.users set display_name = 'hijacked'
    where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: authenticated updated Bob''s profile (%)', n; end if;
end $$;

-- No DELETE policy: a delete attempt removes nothing. Note the count runs as
-- Alice under RLS, so only her own row is visible — that is expected.
do $$
declare
  n int;
begin
  delete from public.predictions
    where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: client deleted own prediction (%)', n; end if;

  select count(*) into n from public.predictions
    where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if n <> 1 then raise exception 'FAIL: own prediction missing after delete attempt, got %', n; end if;
end $$;

-- Own-row writes work: submit a new pick while the round is OPEN…
do $$
begin
  insert into public.predictions (round_id, user_id, category, model_id)
  values ((select id from public.rounds where slug = 'r-main'),
          'aaaaaaaa-0000-0000-0000-000000000001', 'speed',
          (select id from public.llm_models where slug = 'model-b'));
end $$;

-- …edit it while still OPEN (column grant: model_id only)…
do $$
declare
  n int;
begin
  update public.predictions
    set model_id = (select id from public.llm_models where slug = 'model-a')
    where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and category = 'speed';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: authenticated could not edit own pick, rows=%', n; end if;
end $$;

-- …and update own profile columns.
do $$
declare
  n int;
begin
  update public.users set display_name = 'Alice RLS'
    where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: authenticated could not update own profile, rows=%', n; end if;

  select count(*) into n from public.users
    where id = 'aaaaaaaa-0000-0000-0000-000000000001' and display_name = 'Alice RLS';
  if n <> 1 then raise exception 'FAIL: profile update not persisted'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- service_role: bypasses RLS — the server-only path for settlement and
-- evaluation workflows.
-- ---------------------------------------------------------------------------
reset role;
set local role service_role;
set local request.jwt.claims to '{"role":"service_role"}';

do $$
declare
  n int;
begin
  select count(*) into n from public.predictions;
  if n <> 3 then raise exception 'FAIL: service_role cannot bypass RLS on predictions, got %', n; end if;

  select count(*) into n from public.blockchain_transactions;
  if n <> 2 then raise exception 'FAIL: service_role cannot bypass RLS on transactions, got %', n; end if;
end $$;

-- Server-side settlement writes work: score ledger insert + points marking.
do $$
begin
  insert into public.score_events (round_id, user_id, points)
  values ((select id from public.rounds where slug = 'r-main'),
          'aaaaaaaa-0000-0000-0000-000000000001', 10);

  update public.predictions set points_awarded = 10
    where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and category = 'accuracy';
end $$;

-- ---------------------------------------------------------------------------
-- F27: the other side of the two clocks. Once the round locks, an execution
-- becomes readable to a viewer — the live view depends on it, and F17's own
-- tables (generation_chunks, render_previews, judge_verdicts) already scope
-- exactly this way. Asserted as anon so the check cannot pass on a grant the
-- service role holds instead.
-- ---------------------------------------------------------------------------
reset role;
update public.rounds set status = 'LOCKED' where slug = 'r-main';

set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
set local request.jwt.claim.sub to '';

do $$
declare
  n int;
begin
  select count(*) into n from public.model_executions;
  if n < 1 then
    raise exception 'FAIL: anon cannot read model_executions after the round locks';
  end if;
end $$;

-- ---------------------------------------------------------------------------
reset role;
reset request.jwt.claims;
reset request.jwt.claim.sub;

rollback;

select 'rls: all assertions passed' as result;
