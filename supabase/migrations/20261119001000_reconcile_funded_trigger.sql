-- Reconciliation: make sure `users.funded` is actually kept in step with wallets.
--
-- `public.users.funded` is a derived cache: true exactly when the account has a
-- `public.wallets` row. Migration 20261118100900 installs `sync_funded()` and the
-- `wallets_sync_funded` trigger, but `supabase db diff --linked` reported that
-- the hosted project's copy is missing — the kind of drift this repo's
-- migrations are written defensively against.
--
-- That matters now because F18 made `funded` load-bearing: `place_stake` refuses
-- an unfunded account. If linking a wallet does not flip the flag, nobody can
-- ever stake, and the join gate silently blocks the whole product.
--
-- Idempotent by construction: it (re)creates the function and trigger whether or
-- not they exist, then re-derives the flag from the wallets table, so running it
-- on an already-correct database is a no-op in effect.

-- The trigger function, exactly as 20261118100900 defines it.
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

-- Re-derive the cache for every account. This is the repair step: any account
-- with a wallet becomes funded, any without becomes unfunded, which is what the
-- trigger would have produced had it been present all along.
update public.users u
   set funded = exists (
     select 1 from public.wallets w where w.user_id = u.id
   );

-- Canonical comments (the hosted copy drifted to a stale description).
comment on column public.users.funded is
  'Derived: has a linked or sign-in Solana wallet. Maintained by trigger on public.wallets. F18 gates `place_stake` on it.';
comment on column public.users.practice_mode is
  'Wallet-linked account opted into paper trading: joining a round starts no prompt session, and F18 refuses its stakes. Rounds are admin-created; users only join.';

comment on function public.sync_funded() is
  'Reconciliation (F18): keeps users.funded equal to "has a wallets row", so the stake join gate reflects reality.';
