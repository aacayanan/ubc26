-- Profile sync (partial F6) + wallet/funding status model.
--
-- 1. Every new auth account gets a matching public.users row. Until now the
--    row was expected to be created by the app (F6); without it, foreign keys
--    from wallets and predictions fail. A trigger covers every signup path
--    (email, password, Sign in with Solana) in one place and is idempotent.
-- 2. `funded` marks accounts allowed to create competition rounds. No money
--    moves in the MVP — see CLAUDE.md's no-wagering constraint. It is set
--    server-side only; clients hold no grant on the column, so a user cannot
--    promote themselves.
-- 3. `practice_mode` lets a linked account opt into paper trading. It is
--    self-service (granted below) because it can only reduce access, never
--    grant it.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill accounts created before the trigger existed.
insert into public.users (id)
select id from auth.users
on conflict (id) do nothing;

alter table public.users
  add column if not exists funded boolean not null default false;

alter table public.users
  add column if not exists practice_mode boolean not null default false;

-- Users may flip their own practice flag, but not `funded` or `role`.
revoke update on public.users from anon, authenticated;
grant update (display_name, avatar_url, practice_mode) on public.users
  to authenticated;

comment on column public.users.funded is
  'Gates round creation (F8). Server-side only; no money changes hands in the MVP.';
comment on column public.users.practice_mode is
  'Linked account opted into paper trading; cannot create rounds.';

-- Wallets: a user has at most one row (unique user_id), so linking twice must
-- update rather than insert. The grants below already cover the needed columns.
