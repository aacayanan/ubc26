-- Local test harness bootstrap: make a vanilla Postgres look enough like
-- Supabase that the migrations and the SQL assertion scripts apply unchanged.
--
-- This is NOT a Supabase replacement. It creates exactly the pieces the schema
-- touches:
--   * the three roles Supabase ships (`anon`, `authenticated`, `service_role`);
--   * the `auth` schema with a minimal `auth.users` and an `auth.uid()` that
--     reads the same `request.jwt.claim.sub` setting a real session sets;
--   * the default grants Supabase applies to `public` (the RLS policies assume
--     `anon`/`authenticated` hold table grants and are filtered by RLS, not by
--     absent grants).
--
-- Run once per fresh database, before any migration. Idempotent.

-- ---------------------------------------------------------------------------
-- Roles. `service_role` bypasses RLS, matching Supabase; anon/authenticated are
-- nologin roles used only via `set role` in tests.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

alter role service_role bypassrls;

-- ---------------------------------------------------------------------------
-- auth schema: the minimum the migrations reference.
--
-- `auth.users` carries the columns the signup trigger reads (`raw_user_meta_data`,
-- `email`) and every fixture inserts. Supabase's real table has far more; none of
-- it is touched here.
-- ---------------------------------------------------------------------------
create schema if not exists auth;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.role', true), '');
$$;

create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key,
  aud text,
  role text,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Grants: mirror Supabase's defaults so policies, not absent grants, decide
-- access. Applied as default privileges so every migration-created object
-- inherits them; the migrations then narrow specific columns.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

grant select on auth.users to service_role;

alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
