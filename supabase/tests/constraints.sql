-- F2 acceptance test — "Relationships and constraints prevent duplicate or
-- invalid finalized data."
--
-- How to run: paste this entire script into the hosted Supabase SQL editor
-- (runs as postgres) and execute it in one go. Every assertion raises
-- `FAIL: …` if violated; a final `all assertions passed` select confirms
-- success. Everything runs inside one transaction and is rolled back —
-- no data persists.
--
-- Pattern: pg_temp.assert_fails(description, sql, expected_sqlstate,
-- optional message pattern) — the statement MUST be rejected with exactly
-- that error, otherwise the script fails.

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

insert into public.users (id, display_name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Alice'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Bob');

insert into public.llm_models (slug, name, openrouter_model_id) values
  ('model-a', 'Model A', 'org/model-a'),
  ('model-b', 'Model B', 'org/model-b'),
  ('model-c', 'Model C', 'org/model-c');

-- `entry_point` arrived in F13. A published challenge must declare one, so the
-- published fixture sets it; the draft deliberately leaves it null.
insert into public.challenges (slug, title, prompt, status, entry_point) values
  ('c-pub', 'Published challenge', 'Write code.', 'published', 'solve'),
  ('c-draft', 'Draft challenge', 'Work in progress.', 'draft', null);

insert into public.test_cases (challenge_id, kind, ordinal, expected_output) values
  ((select id from public.challenges where slug = 'c-pub'), 'public', 1, 'ok'),
  ((select id from public.challenges where slug = 'c-pub'), 'hidden', 2, 'secret');

insert into public.rounds (slug, challenge_id, prediction_deadline) values
  ('r-main', (select id from public.challenges where slug = 'c-pub'), now() + interval '1 day'),
  ('r-lock', (select id from public.challenges where slug = 'c-pub'), now() + interval '1 day'),
  ('r-past', (select id from public.challenges where slug = 'c-pub'), now() - interval '1 hour'),
  ('r-happy', (select id from public.challenges where slug = 'c-pub'), now() + interval '1 day'),
  ('r-jmp', (select id from public.challenges where slug = 'c-pub'), now() + interval '1 day'),
  ('r-failed', (select id from public.challenges where slug = 'c-pub'), now() + interval '1 day'),
  ('r-cancel', (select id from public.challenges where slug = 'c-pub'), now() + interval '1 day');

update public.rounds set status = 'OPEN'
  where slug in ('r-main', 'r-lock', 'r-past', 'r-jmp', 'r-failed', 'r-cancel');

insert into public.round_models (round_id, model_id)
select r.id, m.id
from public.rounds r
cross join public.llm_models m
where r.slug in ('r-main', 'r-lock', 'r-past')
  and m.slug in ('model-a', 'model-b');

-- One pick per user already in place on r-main and r-lock.
insert into public.predictions (round_id, user_id, category, model_id) values (
  (select id from public.rounds where slug = 'r-main'),
  'aaaaaaaa-0000-0000-0000-000000000001',
  'accuracy',
  (select id from public.llm_models where slug = 'model-a'));

insert into public.predictions (round_id, user_id, category, model_id) values (
  (select id from public.rounds where slug = 'r-lock'),
  'aaaaaaaa-0000-0000-0000-000000000001',
  'accuracy',
  (select id from public.llm_models where slug = 'model-a'));

-- Lock r-lock so late insert/edit tests have a LOCKED round.
update public.rounds set status = 'LOCKED', locked_at = now() where slug = 'r-lock';

insert into public.wallets (user_id, address) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'AliceWalletAddress111'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'BobWalletAddress222');

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
  raise exception 'FAIL: % — statement was accepted: %', p_desc, p_sql;
end;
$$;

-- ---------------------------------------------------------------------------
-- Predictions: uniqueness, round state, deadline, participating models
-- ---------------------------------------------------------------------------
select pg_temp.assert_fails(
  'duplicate prediction (round, user, category)',
  $sql$insert into public.predictions (round_id, user_id, category, model_id) values ((select id from public.rounds where slug = 'r-main'), 'aaaaaaaa-0000-0000-0000-000000000001', 'accuracy', (select id from public.llm_models where slug = 'model-a'))$sql$,
  '23505');

select pg_temp.assert_fails(
  'prediction insert while round is LOCKED',
  $sql$insert into public.predictions (round_id, user_id, category, model_id) values ((select id from public.rounds where slug = 'r-lock'), 'aaaaaaaa-0000-0000-0000-000000000001', 'speed', (select id from public.llm_models where slug = 'model-a'))$sql$,
  'P0001', '%only accepted while the round is OPEN%');

select pg_temp.assert_fails(
  'prediction insert after the deadline',
  $sql$insert into public.predictions (round_id, user_id, category, model_id) values ((select id from public.rounds where slug = 'r-past'), 'aaaaaaaa-0000-0000-0000-000000000001', 'accuracy', (select id from public.llm_models where slug = 'model-a'))$sql$,
  'P0001', '%deadline has passed%');

select pg_temp.assert_fails(
  'prediction on a model that does not participate in the round',
  $sql$insert into public.predictions (round_id, user_id, category, model_id) values ((select id from public.rounds where slug = 'r-main'), 'aaaaaaaa-0000-0000-0000-000000000001', 'speed', (select id from public.llm_models where slug = 'model-c'))$sql$,
  '23503');

select pg_temp.assert_fails(
  'edit a pick after the round is LOCKED',
  $sql$update public.predictions set model_id = (select id from public.llm_models where slug = 'model-b') where round_id = (select id from public.rounds where slug = 'r-lock') and user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and category = 'accuracy'$sql$,
  'P0001', '%only be edited while the round is OPEN%');

select pg_temp.assert_fails(
  'prediction identity columns are immutable',
  $sql$update public.predictions set category = 'speed' where round_id = (select id from public.rounds where slug = 'r-main') and user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and category = 'accuracy'$sql$,
  'P0001', '%identity columns%');

-- ---------------------------------------------------------------------------
-- Round state machine and finalized-round protection
-- ---------------------------------------------------------------------------
select pg_temp.assert_fails(
  'invalid jump OPEN -> SETTLED',
  $sql$update public.rounds set status = 'SETTLED' where slug = 'r-jmp'$sql$,
  'P0001', '%invalid round status transition%');

select pg_temp.assert_fails(
  'round cannot reference a draft challenge',
  $sql$insert into public.rounds (slug, challenge_id, prediction_deadline) values ('r-draft', (select id from public.challenges where slug = 'c-draft'), now() + interval '1 day')$sql$,
  'P0001', '%cannot be used for a round%');

select pg_temp.assert_fails(
  'round deadline must be after prediction_opens_at',
  $sql$insert into public.rounds (slug, challenge_id, prediction_opens_at, prediction_deadline) values ('r-bad', (select id from public.challenges where slug = 'c-pub'), now() + interval '2 days', now() + interval '1 day')$sql$,
  '23514');

-- Happy path: the full lifecycle succeeds.
select pg_temp.assert_ok('CREATED -> OPEN',
  $sql$update public.rounds set status = 'OPEN' where slug = 'r-happy'$sql$);
select pg_temp.assert_ok('OPEN -> LOCKED',
  $sql$update public.rounds set status = 'LOCKED', locked_at = now() where slug = 'r-happy'$sql$);
select pg_temp.assert_ok('LOCKED -> RUNNING',
  $sql$update public.rounds set status = 'RUNNING', started_at = now() where slug = 'r-happy'$sql$);
select pg_temp.assert_ok('RUNNING -> EVALUATING',
  $sql$update public.rounds set status = 'EVALUATING' where slug = 'r-happy'$sql$);
select pg_temp.assert_ok('EVALUATING -> SETTLED',
  $sql$update public.rounds set status = 'SETTLED', settled_at = now() where slug = 'r-happy'$sql$);

-- A SETTLED round's content columns are frozen…
select pg_temp.assert_fails(
  'edit content of a SETTLED round',
  $sql$update public.rounds set slug = 'r-happy-edited' where slug = 'r-happy'$sql$,
  'P0001', '%finalized%');

select pg_temp.assert_ok('SETTLED -> ARCHIVED',
  $sql$update public.rounds set status = 'ARCHIVED', archived_at = now() where slug = 'r-happy'$sql$);

-- …and so are an ARCHIVED round's, which also cannot leave ARCHIVED.
select pg_temp.assert_fails(
  'edit content of an ARCHIVED round',
  $sql$update public.rounds set slug = 'r-happy-edited' where slug = 'r-happy'$sql$,
  'P0001', '%finalized%');

select pg_temp.assert_fails(
  'transition out of ARCHIVED',
  $sql$update public.rounds set status = 'OPEN' where slug = 'r-happy'$sql$,
  'P0001', '%invalid round status transition%');

-- Failure, cancel, and retry transitions.
select pg_temp.assert_ok('OPEN -> LOCKED before failure',
  $sql$update public.rounds set status = 'LOCKED', locked_at = now() where slug = 'r-failed'$sql$);

select pg_temp.assert_ok('LOCKED -> RUNNING before failure',
  $sql$update public.rounds set status = 'RUNNING', started_at = now() where slug = 'r-failed'$sql$);

select pg_temp.assert_ok('RUNNING -> EVALUATING before failure',
  $sql$update public.rounds set status = 'EVALUATING' where slug = 'r-failed'$sql$);

select pg_temp.assert_ok('EVALUATING -> FAILED',
  $sql$update public.rounds set status = 'FAILED' where slug = 'r-failed'$sql$);

select pg_temp.assert_fails(
  'failed round cannot jump directly to SETTLED',
  $sql$update public.rounds set status = 'SETTLED' where slug = 'r-failed'$sql$,
  'P0001', '%invalid round status transition%');

select pg_temp.assert_ok('FAILED -> RETRYING',
  $sql$update public.rounds set status = 'RETRYING' where slug = 'r-failed'$sql$);

select pg_temp.assert_ok('RETRYING -> EVALUATING',
  $sql$update public.rounds set status = 'EVALUATING' where slug = 'r-failed'$sql$);

select pg_temp.assert_ok('OPEN -> CANCELLED',
  $sql$update public.rounds set status = 'CANCELLED' where slug = 'r-cancel'$sql$);

select pg_temp.assert_fails(
  'cancelled round cannot restart',
  $sql$update public.rounds set status = 'OPEN' where slug = 'r-cancel'$sql$,
  'P0001', '%invalid round status transition%');

select pg_temp.assert_ok('create audited transition',
  $sql$select public.transition_round(
    (select id from public.rounds where slug = 'r-failed'),
    'FAILED',
    'EVALUATING',
    'retry produced another failure',
    null
  )$sql$);

select pg_temp.assert_ok('retry target status is idempotent',
  $sql$select public.transition_round(
    (select id from public.rounds where slug = 'r-failed'),
    'FAILED',
    'FAILED',
    'duplicate retry notification',
    null
  )$sql$);

select pg_temp.assert_ok('RPC and direct transitions are auditable',
  $sql$do $audit$
  begin
    if (select count(*) from public.round_transition_events
        where round_id = (select id from public.rounds where slug = 'r-failed')) = 0 then
      raise exception 'missing lifecycle audit events';
    end if;
  end;
  $audit$$sql$);

-- ---------------------------------------------------------------------------
-- Evaluation + settlement idempotency (duplicates rejected)
-- ---------------------------------------------------------------------------
select pg_temp.assert_ok('insert model execution',
  $sql$insert into public.model_executions (round_id, model_id, run_type, openrouter_model_id) values ((select id from public.rounds where slug = 'r-main'), (select id from public.llm_models where slug = 'model-a'), 'generation', 'org/model-a')$sql$);

select pg_temp.assert_fails(
  'duplicate model execution (round, model, run_type, attempt)',
  $sql$insert into public.model_executions (round_id, model_id, run_type, openrouter_model_id) values ((select id from public.rounds where slug = 'r-main'), (select id from public.llm_models where slug = 'model-a'), 'generation', 'org/model-a')$sql$,
  '23505');

select pg_temp.assert_ok('insert test result',
  $sql$insert into public.test_results (execution_id, test_case_id, passed) values ((select id from public.model_executions where round_id = (select id from public.rounds where slug = 'r-main') limit 1), (select id from public.test_cases where ordinal = 1 limit 1), true)$sql$);

select pg_temp.assert_fails(
  'duplicate test result (execution, test_case)',
  $sql$insert into public.test_results (execution_id, test_case_id, passed) values ((select id from public.model_executions where round_id = (select id from public.rounds where slug = 'r-main') limit 1), (select id from public.test_cases where ordinal = 1 limit 1), false)$sql$,
  '23505');

select pg_temp.assert_ok('insert competition result',
  $sql$insert into public.competition_results (round_id, model_id, category, status, placement, metric_value) values ((select id from public.rounds where slug = 'r-main'), (select id from public.llm_models where slug = 'model-a'), 'accuracy', 'qualified', 1, 10)$sql$);

select pg_temp.assert_fails(
  'duplicate competition result (round, model, category) — settlement idempotency',
  $sql$insert into public.competition_results (round_id, model_id, category, status, placement, metric_value) values ((select id from public.rounds where slug = 'r-main'), (select id from public.llm_models where slug = 'model-a'), 'accuracy', 'qualified', 1, 10)$sql$,
  '23505');

select pg_temp.assert_ok('insert score event',
  $sql$insert into public.score_events (round_id, user_id, points) values ((select id from public.rounds where slug = 'r-main'), 'aaaaaaaa-0000-0000-0000-000000000001', 10)$sql$);

select pg_temp.assert_fails(
  'duplicate score event (round, user) — settlement idempotency',
  $sql$insert into public.score_events (round_id, user_id, points) values ((select id from public.rounds where slug = 'r-main'), 'aaaaaaaa-0000-0000-0000-000000000001', 10)$sql$,
  '23505');

select pg_temp.assert_ok('settle r-main for finalized-result protection',
  $sql$update public.rounds set status = 'LOCKED', locked_at = now() where slug = 'r-main'$sql$);
select pg_temp.assert_ok('run r-main for finalized-result protection',
  $sql$update public.rounds set status = 'RUNNING', started_at = now() where slug = 'r-main'$sql$);
select pg_temp.assert_ok('evaluate r-main for finalized-result protection',
  $sql$update public.rounds set status = 'EVALUATING' where slug = 'r-main'$sql$);
select pg_temp.assert_ok('settle r-main',
  $sql$update public.rounds set status = 'SETTLED', settled_at = now() where slug = 'r-main'$sql$);

select pg_temp.assert_fails(
  'settled round competition result cannot be edited',
  $sql$update public.competition_results set metric_value = 999 where round_id = (select id from public.rounds where slug = 'r-main')$sql$,
  'P0001', '%finalized round%');

select pg_temp.assert_fails(
  'settled round competition result cannot be deleted',
  $sql$delete from public.competition_results where round_id = (select id from public.rounds where slug = 'r-main')$sql$,
  'P0001', '%finalized round%');

select pg_temp.assert_fails(
  'settled round score event cannot be edited',
  $sql$update public.score_events set points = 999 where round_id = (select id from public.rounds where slug = 'r-main')$sql$,
  'P0001', '%finalized round%');

-- ---------------------------------------------------------------------------
-- Catalog + identity uniqueness and check constraints
-- ---------------------------------------------------------------------------
select pg_temp.assert_fails(
  'duplicate challenge (slug, version)',
  $sql$insert into public.challenges (slug, version, title, prompt, status, entry_point) values ('c-pub', 1, 'Dup', 'Dup.', 'published', 'solve')$sql$,
  '23505');

select pg_temp.assert_fails(
  'second wallet for the same user',
  $sql$insert into public.wallets (user_id, address) values ('aaaaaaaa-0000-0000-0000-000000000001', 'AnotherAddress333')$sql$,
  '23505');

select pg_temp.assert_fails(
  'wallet address claimed by another user',
  $sql$insert into public.wallets (user_id, address) values ('aaaaaaaa-0000-0000-0000-000000000002', 'AliceWalletAddress111')$sql$,
  '23505');

select pg_temp.assert_fails(
  'negative total_points rejected',
  $sql$insert into public.user_scores (user_id, total_points) values ('aaaaaaaa-0000-0000-0000-000000000002', -1)$sql$,
  '23514');

-- ---------------------------------------------------------------------------
-- Blockchain transaction dedup
-- ---------------------------------------------------------------------------
select pg_temp.assert_ok('insert blockchain transaction',
  $sql$insert into public.blockchain_transactions (idempotency_key, signature, purpose, status, user_id) values ('tx-key-1', 'sig-1', 'prediction_commitment', 'confirmed', 'aaaaaaaa-0000-0000-0000-000000000001')$sql$);

select pg_temp.assert_fails(
  'duplicate idempotency_key — tx retry creates no second record',
  $sql$insert into public.blockchain_transactions (idempotency_key, signature, purpose, status, user_id) values ('tx-key-1', 'sig-2', 'prediction_commitment', 'confirmed', 'aaaaaaaa-0000-0000-0000-000000000001')$sql$,
  '23505');

select pg_temp.assert_fails(
  'duplicate signature',
  $sql$insert into public.blockchain_transactions (idempotency_key, signature, purpose, status, user_id) values ('tx-key-2', 'sig-1', 'prediction_commitment', 'confirmed', 'aaaaaaaa-0000-0000-0000-000000000001')$sql$,
  '23505');

-- ---------------------------------------------------------------------------
-- F13 sandbox: challenge entry point (the function the sandbox calls)
-- ---------------------------------------------------------------------------
-- F12's seed bank must set entry_point before flipping a challenge to
-- 'published', or the update below fails.
select pg_temp.assert_fails(
  'publishing a challenge without an entry point',
  $sql$update public.challenges set status = 'published' where slug = 'c-draft'$sql$,
  '23514');

select pg_temp.assert_fails(
  'entry point cannot shadow a dunder name',
  $sql$update public.challenges set entry_point = '__import__' where slug = 'c-draft'$sql$,
  '23514');

select pg_temp.assert_fails(
  'entry point rejects non-identifier characters',
  $sql$update public.challenges set entry_point = 'solve; drop table x' where slug = 'c-draft'$sql$,
  '23514');

select pg_temp.assert_ok(
  'a draft may carry a valid entry point',
  $sql$update public.challenges set entry_point = 'main' where slug = 'c-draft'$sql$);

select pg_temp.assert_ok(
  'a model execution records its sandbox image and protocol',
  $sql$insert into public.model_executions (round_id, model_id, run_type, openrouter_model_id, sandbox_image, harness_protocol) values ((select id from public.rounds where slug = 'r-main'), (select id from public.llm_models where slug = 'model-c'), 'generation', 'org/model-c', 'ai-showdown-sandbox:py3.12@sha256:0000000000000000000000000000000000000000000000000000000000000000', 1)$sql$);

-- ---------------------------------------------------------------------------
rollback;

select 'constraints: all assertions passed' as result;
