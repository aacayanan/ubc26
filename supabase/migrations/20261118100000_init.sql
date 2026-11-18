-- F2: init — shared trigger function and enum types for the whole schema.
-- Applied first; every later migration depends on these types.

-- Defensive: gen_random_uuid() is core in Supabase's PostgreSQL, but pin the
-- extension so fresh databases are identical everywhere.
create extension if not exists pgcrypto;

-- Shared trigger: keep updated_at fresh on every UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Competition lifecycle state machine (CLAUDE.md / REQUIREMENTS.md F7).
-- Upper-case values mirror the documented CREATED → OPEN → … notation.
-- NOTE: the allowed-transition pairs live in the rounds trigger
-- (20261118100300_rounds.sql) — update BOTH when adding values here.
create type public.round_status as enum (
  'CREATED',
  'OPEN',
  'LOCKED',
  'RUNNING',
  'EVALUATING',
  'SETTLED',
  'ARCHIVED',
  'CANCELLED',
  'FAILED',
  'RETRYING',
  'VOIDED'
);

-- Mirrors PredictionCategory in packages/shared/src/index.ts — keep in sync.
create type public.prediction_category as enum ('accuracy', 'speed', 'code_length');

-- Evaluation runs: generation produces the solution; warmup/benchmark runs
-- measure speed under fixed conditions (REQUIREMENTS.md F14).
create type public.execution_run_type as enum ('generation', 'warmup', 'benchmark');

-- timeout / unavailable are first-class outcomes (REQUIREMENTS.md F16).
create type public.execution_status as enum (
  'pending',
  'running',
  'succeeded',
  'timeout',
  'error',
  'unavailable'
);

-- forfeited = execution error/timeout in a qualifying category (F15);
-- failed = the model itself was unavailable.
create type public.result_status as enum ('qualified', 'forfeited', 'failed', 'unavailable');

create type public.challenge_status as enum ('draft', 'published', 'archived');

-- Hidden test cases must never be readable by clients (F12).
create type public.test_kind as enum ('public', 'hidden');

create type public.user_role as enum ('user', 'admin');

create type public.tx_status as enum ('pending', 'confirmed', 'failed', 'timeout');

-- Scope-agnostic purposes so the schema works for lightweight tx records now
-- and an Anchor program later (G1 gated until M5).
create type public.tx_purpose as enum (
  'prediction_commitment',
  'round_record',
  'settlement',
  'wallet_verification'
);
