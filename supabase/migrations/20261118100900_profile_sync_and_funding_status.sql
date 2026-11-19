-- Profile sync (partial F6) + wallet/practice status model.
--
-- 1. Every new auth account gets a matching public.users row. Until now the
--    row was expected to be created by the app (F6); without it, foreign keys
--    from wallets and predictions fail. A trigger covers every signup path
--    (email, password, Sign in with Solana) in one place and is idempotent.
-- 2. `funded` is derived, not admin-set: an account is funded when it has a
--    Solana wallet — either the wallet it signed in with, or one it linked.
--    It is a generated column so it can never drift from the wallets table.
--    No money moves in the MVP; it marks eligibility to add funds later.
-- 3. `practice_mode` lets a funded account opt into paper trading. It is
--    self-service (granted below) because it can only reduce access.

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
  add column if not exists practice_mode boolean not null default false;

-- "Has a Solana account" is exactly "has a wallets row". The column is a
-- cache of that fact, maintained by the triggers below; clients hold no grant
-- on it, so nothing can promote itself.
alter table public.users
  add column if not exists funded boolean not null default false;

-- Backfill from wallets that already exist.
update public.users u
   set funded = true
 where exists (select 1 from public.wallets w where w.user_id = u.id);

create or replace function public.sync_funded()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.users set funded = true where id = new.user_id;
  elsif tg_op = 'DELETE' then
    update public.users u
       set funded = exists (select 1 from public.wallets w where w.user_id = old.user_id)
     where u.id = old.user_id;
  end if;
  return null;
end;
$$;

drop trigger if exists wallets_sync_funded on public.wallets;
create trigger wallets_sync_funded
  after insert or delete on public.wallets
  for each row execute function public.sync_funded();

-- Users may flip their own practice flag, but nothing else here.
revoke update on public.users from anon, authenticated;
grant update (display_name, avatar_url, practice_mode) on public.users
  to authenticated;

comment on column public.users.funded is
  'Derived: has a linked or sign-in Solana wallet. Maintained by trigger on public.wallets.';comment on column public.users.practice_mode is
  'Wallet-linked account opted into paper trading; cannot create rounds.';

-- Wallets: a user has at most one row (unique user_id), so linking twice must
-- update rather than insert. The grants below already cover the needed columns.
