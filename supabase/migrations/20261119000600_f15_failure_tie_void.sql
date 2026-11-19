-- F15: failure, tie and void behavior.
--
-- Three things the schema could not say before this migration:
--
--   1. **What a per-model failure means.** `result_status` was
--      ('qualified', 'forfeited', 'failed', 'unavailable') from the pre-pivot
--      coding-test format. The visual-brief vocabulary is conformance:
--      'conformed', 'not_conformed', 'forfeited', 'unavailable'. The old values
--      are mapped, not dropped, so pre-pivot rows stay readable.
--   2. **Which outcome a round settled on.** A tie needs the crowd vote to break
--      it, and a void needs to say why every stake came back. That is one row
--      per round in `round_outcomes`, written once and immutable thereafter.
--   3. **That a tie was broken deliberately.** `tie_break` records whether the
--      winner was the sole conformer, the crowd's pick, or (when the vote itself
--      tied) a fixed round order — so a recorded winner is never an unexplained
--      coin flip.
--
-- Idempotent throughout: the hosted project has drifted from migration history
-- before, and an enum value or check constraint may already exist.

-- ---------------------------------------------------------------------------
-- 1. result_status gains the conformance vocabulary.
--
-- `alter type ... add value` cannot run inside a transaction block in older
-- Postgres and cannot be rolled back, so this file does not wrap it. Adding an
-- unused value is harmless on a re-run (IF NOT EXISTS).
-- ---------------------------------------------------------------------------
alter type public.result_status add value if not exists 'conformed';
alter type public.result_status add value if not exists 'not_conformed';

-- Stakes are now placed on conformance, not on the retired accuracy/speed/
-- code-length categories. Adding the value (rather than renaming) keeps the
-- pre-pivot rows valid while making `competition_results.category =
-- 'conformance'` the shape F15 writes.
alter type public.prediction_category add value if not exists 'conformance';

comment on type public.prediction_category is
  'What a stake or result row is about. ''conformance'' is the post-pivot category (F15/F18); accuracy/speed/code_length are the retired pre-pivot categories, kept only for historical rows.';

comment on type public.result_status is
  'Per-model round outcome (F15). conformed/not_conformed = judge ruling on a gate-passing render; forfeited = failed the deterministic gate (render error, timeout, missing frames, blank canvas); unavailable = infrastructure or judge outage, retryable, never a verdict.';

-- ---------------------------------------------------------------------------
-- 2. One recorded outcome per round.
--
-- Written by the settlement path (F18) after `resolveRoundOutcome` decides.
-- A round has exactly one: re-resolving an interrupted settlement upserts rather
-- than duplicating, matching the same idempotency discipline as
-- model_executions and rendered_artifacts.
-- ---------------------------------------------------------------------------
create table if not exists public.round_outcomes (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null unique references public.rounds (id) on delete cascade,
  -- 'settled' or 'voided'. A retryable round has no outcome row at all — it is
  -- still being decided, and writing one would be the guess F15 forbids.
  kind text not null check (kind in ('settled', 'voided')),
  -- The conformance winner (the model backers of which split the pool). NULL on
  -- a void. Populated only when kind = 'settled'.
  winner_model_id uuid references public.llm_models (id),
  -- The crowd's fan-favorite pick, an outcome independent of conformance. NULL
  -- when nobody voted or the round was voided.
  fan_favorite_model_id uuid references public.llm_models (id),
  -- How a tie was broken when more than one model conformed.
  tie_break text check (tie_break in ('sole-conformer', 'crowd-vote', 'stable-order')),
  -- Plain-language explanation, safe to show a viewer (F19). Says why the round
  -- settled or was voided.
  reason text not null,
  -- Whether the round was void because every model forfeited versus no model
  -- conforming at all. Kept separate so F19 can explain the difference.
  all_forfeited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A settled outcome names a winner and a tiebreak; a void names neither.
  constraint round_outcomes_settled_shape check (
    (kind = 'settled' and winner_model_id is not null and tie_break is not null)
    or (kind = 'voided' and winner_model_id is null and tie_break is null)
  )
);

-- `create table if not exists` skips the whole definition on a re-run, so the
-- trigger is dropped and recreated; the inline constraint above is owned by the
-- table create and so needs no separate guard.

drop trigger if exists round_outcomes_set_updated_at on public.round_outcomes;
create trigger round_outcomes_set_updated_at
  before update on public.round_outcomes
  for each row execute function public.set_updated_at();

alter table public.round_outcomes enable row level security;

-- Outcome rows are public record, same as competition_results. Writes are
-- service-role only (no write policy).
drop policy if exists round_outcomes_public_read on public.round_outcomes;
create policy round_outcomes_public_read on public.round_outcomes
  for select using (true);

-- Finalized rounds cannot have their outcome rewritten. Mirrors
-- `prevent_finalized_result_edits` for competition_results and score_events.
create or replace function public.prevent_finalized_outcome_edits()
returns trigger
language plpgsql
as $$
declare
  v_status public.round_status;
begin
  select status into v_status
    from public.rounds
    where id = old.round_id;

  if v_status in ('SETTLED', 'VOIDED', 'ARCHIVED') then
    raise exception 'the outcome of finalized round % cannot be modified',
      old.round_id;
  end if;

  return new;
end;
$$;

drop trigger if exists round_outcomes_prevent_finalized_edits
  on public.round_outcomes;
create trigger round_outcomes_prevent_finalized_edits
  before update or delete on public.round_outcomes
  for each row execute function public.prevent_finalized_outcome_edits();

comment on table public.round_outcomes is
  'F15: the one recorded outcome of a settled or voided round, including how a tie was broken. A retryable round has no row.';
comment on column public.round_outcomes.winner_model_id is
  'The conforming model whose backers split the pool. NULL on a void.';
comment on column public.round_outcomes.fan_favorite_model_id is
  'The crowd vote winner, independent of conformance (F32). NULL when nobody voted.';
comment on column public.round_outcomes.tie_break is
  'sole-conformer = only one model conformed; crowd-vote = the fan-favorite vote decided between several; stable-order = the vote itself tied and fixed round order decided.';

-- ---------------------------------------------------------------------------
-- 3. Stakes must move on a void.
--
-- `void rounds do not silently keep stakes` (F15 acceptance). `predictions`
-- gains `settled_at` so settlement can prove every stake in a round was handled,
-- and a guard that refuses to finalize a round while any prediction in it is
-- still unsettled.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'predictions'
      and column_name = 'settled_at'
  ) then
    alter table public.predictions add column settled_at timestamptz;
  end if;
end
$$;

comment on column public.predictions.settled_at is
  'When settlement resolved this stake: paid out, lost, or returned on a void (F15/F18). NULL means still open or awaiting settlement.';

-- Points returned on a void are not an award, so `points_awarded` stays 0 and
-- this column says why. Kept as free text so F18 can add outcomes without
-- another migration.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'predictions'
      and column_name = 'settlement_outcome'
  ) then
    alter table public.predictions add column settlement_outcome text
      check (
        settlement_outcome is null
        or settlement_outcome in ('won', 'lost', 'void')
      );
  end if;
end
$$;

comment on column public.predictions.settlement_outcome is
  'won = backed the conforming winner; lost = backed a model that did not win; void = round voided and the stake returned. NULL until settled.';

-- The latch against a void that forgets a stake. A round may only enter
-- SETTLED/VOIDED once every prediction on it has a settled_at; the settlement
-- path settles stakes first, then transitions. Enforced in the database so a
-- route that forgets the order fails loudly instead of stranding points.
--
-- Legacy exception: rows already carrying the pre-pivot categories
-- (accuracy/speed/code_length) predate staking-on-conformance and have no stake
-- to settle. They are exempt so historical rounds stay re-transitionable. Any
-- row in the current 'conformance' category must be settled.
create or replace function public.ensure_round_stakes_settled()
returns trigger
language plpgsql
as $$
declare
  v_unsettled integer;
begin
  if old.status is distinct from new.status
     and new.status in ('SETTLED', 'VOIDED') then
    select count(*) into v_unsettled
      from public.predictions
      where round_id = new.id
        and settled_at is null
        and category = 'conformance';

    if v_unsettled > 0 then
      raise exception 'round % has % unsettled stake(s); settle every stake before finalizing',
        new.id, v_unsettled
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists rounds_ensure_stakes_settled on public.rounds;
create trigger rounds_ensure_stakes_settled
  before update of status on public.rounds
  for each row execute function public.ensure_round_stakes_settled();

-- A void writes no score event and no result award; the guard above is what
-- keeps it honest. Round void_reason already exists (20261118100300_rounds.sql)
-- and `round_outcomes.reason` is the structured copy aimed at viewers.
