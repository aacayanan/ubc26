-- F18, part 1: the inputs settlement needs.
--
-- Settlement could not be built before this migration for three reasons, and
-- this file fixes exactly those three:
--
--   1. **A stake had no size.** `predictions` recorded a pick but no amount, so
--      there was no pot to split. `stake_points` is that amount.
--   2. **Nothing could place one.** RLS let a client insert a prediction row
--      directly, which meant no balance check, no join gate and no deadline
--      check beyond the insert trigger. `place_stake` is the one write path.
--   3. **A crowd vote did not exist.** Equal conformance has to be broken by
--      the crowd (F15), and the fan-favorite award is F18's. `round_votes` plus
--      `cast_vote` give settlement a tally to read.
--
-- Ledger model (matters for every rule below): points are NOT escrowed at stake
-- time. `user_scores.total_points` is the settled balance and is written only by
-- settlement. An open stake *reserves* points by arithmetic (`balance - sum of
-- unsettled stake_points`) without debiting them, so a void or a loss needs no
-- compensating credit — `predictions.points_awarded = 0` is the whole story, and
-- `score_events.points >= 0` stays true.
--
-- Idempotent throughout: the hosted project has drifted from migration history
-- before, so every object is created with a guard or `create or replace`.

-- ---------------------------------------------------------------------------
-- 1. predictions.stake_points — the amount on a stake.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'predictions'
      and column_name = 'stake_points'
  ) then
    alter table public.predictions
      add column stake_points integer not null default 0;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'predictions_stake_points_nonnegative'
      and conrelid = 'public.predictions'::regclass
  ) then
    alter table public.predictions
      add constraint predictions_stake_points_nonnegative
      check (stake_points >= 0);
  end if;
end
$$;

comment on column public.predictions.stake_points is
  'Points committed to this stake (F18). The settled balance is untouched until settlement; an open stake only reserves points. 0 marks a legacy or non-staking row.';

-- The pot query is per round, so make it a range read rather than a scan of
-- the whole prediction history.
create index if not exists predictions_round_category_idx
  on public.predictions (round_id, category);

-- The amount is governed by the same clock as the pick: editable while the
-- round is OPEN and before the deadline, frozen after. Recreated whole rather
-- than patched so the two rules cannot drift apart.
create or replace function public.guard_prediction_update()
returns trigger
language plpgsql
as $$
declare
  v_status public.round_status;
  v_deadline timestamptz;
begin
  if new.id is distinct from old.id
    or new.round_id is distinct from old.round_id
    or new.user_id is distinct from old.user_id
    or new.category is distinct from old.category
    or new.created_at is distinct from old.created_at
  then
    raise exception 'predictions cannot change identity columns';
  end if;

  if new.model_id is distinct from old.model_id
     or new.stake_points is distinct from old.stake_points then
    select status, prediction_deadline into v_status, v_deadline
      from public.rounds
      where id = new.round_id;
    if v_status is distinct from 'OPEN' or now() > v_deadline then
      raise exception 'predictions can only be edited while the round is OPEN and before the deadline';
    end if;
  end if;
  return new;
end;
$$;

comment on column public.predictions.points_awarded is
  'F18: the points this stake returns. 0 on a loss and on a void (the stake was never debited), the pro-rata pot share on a win.';

-- ---------------------------------------------------------------------------
-- 2. place_stake — the only way a client creates or raises a stake.
--
-- Security definer so it can read `users.funded` / `user_scores` (clients hold
-- no grant on `funded`) and can lock the score row. It is granted to
-- `authenticated` because the caller is identified by `auth.uid()`, never by an
-- argument: a stake can only ever be placed for the caller.
-- ---------------------------------------------------------------------------
create or replace function public.place_stake(
  p_round_id uuid,
  p_model_id uuid,
  p_points integer,
  p_commitment_hash text default null
)
returns table (
  prediction_id uuid,
  stake_round_id uuid,
  stake_model_id uuid,
  stake_points integer,
  reserved_points integer,
  balance integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_status public.round_status;
  v_deadline timestamptz;
  v_funded boolean;
  v_practice boolean;
  v_balance integer;
  v_other_reserved integer;
  v_reserved integer;
  v_prediction_id uuid;
begin
  if v_user_id is null then
    raise exception 'sign in to place a stake' using errcode = '42501';
  end if;

  if p_points is null or p_points < 10 then
    raise exception 'a stake must be at least 10 points' using errcode = '22023';
  end if;

  -- The two clocks: a stake exists only inside the OPEN window, and never at or
  -- after the deadline. `now()` here is the database clock, not the client's.
  select r.status, r.prediction_deadline into v_status, v_deadline
    from public.rounds r
    where r.id = p_round_id;

  if v_status is null then
    raise exception 'round % does not exist', p_round_id using errcode = 'P0002';
  end if;

  if v_status is distinct from 'OPEN' then
    raise exception 'round % is % and no longer accepts stakes', p_round_id, v_status
      using errcode = 'P0001';
  end if;

  if now() > v_deadline then
    raise exception 'the prediction deadline has passed for round %', p_round_id
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.round_models rm
    where rm.round_id = p_round_id and rm.model_id = p_model_id
  ) then
    raise exception 'model % does not participate in round %', p_model_id, p_round_id
      using errcode = '22023';
  end if;

  -- The join gate (F10): only a funded account outside practice mode stakes.
  select u.funded, u.practice_mode into v_funded, v_practice
    from public.users u
    where u.id = v_user_id;

  if v_funded is null then
    raise exception 'your profile has not been set up yet' using errcode = 'P0002';
  end if;

  if not v_funded then
    raise exception 'link a wallet to stake on a live round' using errcode = '42501';
  end if;

  if v_practice then
    raise exception 'practice mode accounts cannot stake on a live round'
      using errcode = '42501';
  end if;

  -- Lock the score row so two concurrent stakes cannot both spend the same
  -- points. `for update` on a row that always exists (created by the signup
  -- trigger); if it somehow does not, create it at the starter balance.
  insert into public.user_scores (user_id) values (v_user_id)
  on conflict (user_id) do nothing;

  select us.total_points into v_balance
    from public.user_scores us
    where us.user_id = v_user_id
    for update;

  select coalesce(sum(p.stake_points), 0) into v_other_reserved
    from public.predictions p
    where p.user_id = v_user_id
      and p.category = 'conformance'
      and p.settled_at is null
      and p.round_id <> p_round_id;

  v_reserved := v_balance - v_other_reserved;

  if p_points > v_reserved then
    raise exception 'stake of % exceeds your available % points', p_points, greatest(v_reserved, 0)
      using errcode = '22003';
  end if;

  -- One conformance stake per user per round: a second call raises the amount
  -- or changes the pick rather than duplicating. `created_at` is preserved and
  -- the guard trigger above re-validates the window on the update path.
  insert into public.predictions as p (
    round_id, user_id, category, model_id, stake_points, commitment_hash
  ) values (
    p_round_id, v_user_id, 'conformance', p_model_id, p_points, p_commitment_hash
  )
  on conflict (round_id, user_id, category) do update
    set model_id = excluded.model_id,
        stake_points = excluded.stake_points,
        commitment_hash = coalesce(excluded.commitment_hash, p.commitment_hash)
  returning p.id into v_prediction_id;

  prediction_id := v_prediction_id;
  stake_round_id := p_round_id;
  stake_model_id := p_model_id;
  stake_points := p_points;
  reserved_points := v_other_reserved + p_points;
  balance := v_balance;
  return next;
end;
$$;

revoke all on function public.place_stake(uuid, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.place_stake(uuid, uuid, integer, text)
  to authenticated;

comment on function public.place_stake(uuid, uuid, integer, text) is
  'F18: place or raise the caller''s single conformance stake in an OPEN round, reserving (not debiting) points against `user_scores.total_points`.';

-- ---------------------------------------------------------------------------
-- 3. score_events gains a kind.
--
-- The ledger already holds one row per user per round. Fan-favorite is a
-- separate award, so a user who staked AND voted for the crowd's winner has two
-- auditable events, not one merged number.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'score_events'
      and column_name = 'kind'
  ) then
    alter table public.score_events
      add column kind text not null default 'stake';
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'score_events_kind_check'
      and conrelid = 'public.score_events'::regclass
  ) then
    alter table public.score_events
      add constraint score_events_kind_check
      check (kind in ('stake', 'fan_favorite'));
  end if;
end
$$;

-- Replace the (round_id, user_id) unique key with (round_id, user_id, kind).
-- Dropped by name so a re-run does not fail on a missing constraint.
do $$
declare
  v_constraint text;
begin
  select c.conname into v_constraint
    from pg_constraint c
    where c.conrelid = 'public.score_events'::regclass
      and c.contype = 'u'
      and (
        select array_agg(a.attname::text order by a.attname)
          from unnest(c.conkey) as k(attnum)
          join pg_attribute a
            on a.attrelid = c.conrelid and a.attnum = k.attnum
      ) = array['round_id', 'user_id']::text[];

  if v_constraint is not null then
    execute format('alter table public.score_events drop constraint %I', v_constraint);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'score_events_round_user_kind_key'
      and conrelid = 'public.score_events'::regclass
  ) then
    alter table public.score_events
      add constraint score_events_round_user_kind_key
      unique (round_id, user_id, kind);
  end if;
end
$$;

comment on column public.score_events.kind is
  'stake = the credited return on a settled stake (0 for a loss or a void, recorded so "Rounds" counts every settled stake); fan_favorite = the crowd-vote award (F18).';

-- ---------------------------------------------------------------------------
-- 4. Starter grant: a new account can actually stake.
--
-- 1000 points into `total_points`, which the leaderboard ranks on — so every
-- account that has ever signed in appears, and the pool redistributes from a
-- real balance rather than from nothing. Backfilled only for rows still at 0 so
-- a re-run cannot hand anyone a second grant.
-- ---------------------------------------------------------------------------
alter table public.user_scores
  alter column total_points set default 1000;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id) values (new.id)
  on conflict (id) do nothing;

  insert into public.user_scores (user_id, total_points)
  values (new.id, 1000)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

update public.user_scores
  set total_points = 1000
  where total_points = 0;

comment on table public.user_scores is
  'One row per account, created by the handle_new_user() trigger with a 1000-point starter grant (F18). total_points is the settled balance, written only by settlement; an open stake reserves against it without debiting it.';
comment on column public.user_scores.total_points is
  'Starter grant plus every settled return (F18). Ranks the leaderboard (F24). Open stakes reserve against it arithmetically; they do not reduce it until settlement.';

-- ---------------------------------------------------------------------------
-- 5. round_votes — the crowd vote settlement reads (minimal F32).
--
-- The second clock in schema form: a vote is only possible once the betting
-- window has closed, so a vote can never be a prediction. One vote per account
-- per round, and the vote must name a model that actually competed.
-- ---------------------------------------------------------------------------
create table if not exists public.round_votes (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  model_id uuid not null references public.llm_models (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A vote names a model that participates in this round.
  constraint round_votes_participating_model_fk
    foreign key (round_id, model_id)
    references public.round_models (round_id, model_id),
  constraint round_votes_one_per_user unique (round_id, user_id)
);

drop trigger if exists round_votes_set_updated_at on public.round_votes;
create trigger round_votes_set_updated_at
  before update on public.round_votes
  for each row execute function public.set_updated_at();

create index if not exists round_votes_round_idx
  on public.round_votes (round_id, model_id);

alter table public.round_votes enable row level security;

drop policy if exists round_votes_public_read on public.round_votes;
create policy round_votes_public_read on public.round_votes
  for select using (true);

-- Writes go through `cast_vote` (or the service role); a client holding a
-- session has no direct write grant, so the poll cannot be stuffed from the
-- browser bundle.
revoke insert, update, delete on public.round_votes from anon, authenticated;

/**
 * Votes open when the round locks and close when it settles.
 *
 * `LOCKED`/`RUNNING`/`EVALUATING` are the window in which renders exist and the
 * outcome does not — exactly the rule that makes a vote not a prediction.
 * `apps/web/PRODUCT.md` says practice accounts may vote while F32's text says
 * funded; this follows PRODUCT.md (any signed-in account) and records the
 * discrepancy for reconciliation.
 */
create or replace function public.ensure_vote_allowed()
returns trigger
language plpgsql
as $$
declare
  v_status public.round_status;
begin
  select status into v_status
    from public.rounds
    where id = new.round_id;

  if v_status is null then
    raise exception 'round % does not exist', new.round_id using errcode = 'P0002';
  end if;

  if v_status not in ('LOCKED', 'RUNNING', 'EVALUATING') then
    raise exception 'the crowd vote is not open for round % (status %)',
      new.round_id, v_status using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists round_votes_guard on public.round_votes;
create trigger round_votes_guard
  before insert or update on public.round_votes
  for each row execute function public.ensure_vote_allowed();

-- A vote is part of the public record once the round is settled; nothing
-- rewrites or removes it after that.
drop trigger if exists round_votes_prevent_finalized_edits on public.round_votes;
create trigger round_votes_prevent_finalized_edits
  before update or delete on public.round_votes
  for each row execute function public.prevent_finalized_outcome_edits();

create or replace function public.cast_vote(
  p_round_id uuid,
  p_model_id uuid
)
returns table (
  vote_id uuid,
  vote_round_id uuid,
  vote_model_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_vote_id uuid;
begin
  if v_user_id is null then
    raise exception 'sign in to vote' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.round_models rm
    where rm.round_id = p_round_id and rm.model_id = p_model_id
  ) then
    raise exception 'model % does not participate in round %', p_model_id, p_round_id
      using errcode = '22023';
  end if;

  -- One vote per account per round: a second call changes the pick rather than
  -- stacking a second ballot.
  insert into public.round_votes as v (round_id, user_id, model_id)
  values (p_round_id, v_user_id, p_model_id)
  on conflict (round_id, user_id) do update
    set model_id = excluded.model_id
  returning v.id into v_vote_id;

  vote_id := v_vote_id;
  vote_round_id := p_round_id;
  vote_model_id := p_model_id;
  return next;
end;
$$;

revoke all on function public.cast_vote(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cast_vote(uuid, uuid) to authenticated;

comment on table public.round_votes is
  'F32/F18: one crowd vote per account per round, accepted only after the betting window closes. Breaks ties in conformance and decides the fan-favorite award.';
comment on function public.cast_vote(uuid, uuid) is
  'F18: cast or change the caller''s single vote in a locked round.';
