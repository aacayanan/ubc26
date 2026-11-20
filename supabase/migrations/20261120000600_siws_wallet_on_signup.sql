-- Sign in with Solana accounts are funded from the moment they sign up.
--
-- `users.funded` is derived from `public.wallets`, but nothing wrote a wallets
-- row for a Phantom (web3) sign-in: `handle_new_user()` created only the
-- `public.users` row, and the app bridged the sign-in address into `wallets`
-- lazily, inside the wager path. The UI gates wagering on `funded`, so a
-- wallet-identified account was shown "No wallet" and never reached that path.
--
-- Supabase stores the signed-in address at
-- `raw_user_meta_data -> 'custom_claims' ->> 'address'` (chain = 'solana').
-- The SIWS signature proves ownership, so the row is stamped verified.
-- If the address is already linked to another account, nothing is inserted
-- (wallets.address is unique); that account keeps the link.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_address text;
begin
  insert into public.users (id) values (new.id)
  on conflict (id) do nothing;

  if new.raw_user_meta_data -> 'custom_claims' ->> 'chain' = 'solana' then
    v_address := new.raw_user_meta_data -> 'custom_claims' ->> 'address';
    if v_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
      insert into public.wallets (user_id, address, cluster, verified_at)
      values (new.id, v_address, 'devnet', now())
      on conflict do nothing;
    end if;
  end if;

  return new;
end;
$$;

-- Backfill: existing Sign in with Solana accounts with no wallet row.
insert into public.wallets (user_id, address, cluster, verified_at)
select u.id,
       u.raw_user_meta_data -> 'custom_claims' ->> 'address',
       'devnet',
       now()
  from auth.users u
  join public.users pu on pu.id = u.id
 where u.raw_user_meta_data -> 'custom_claims' ->> 'chain' = 'solana'
   and (u.raw_user_meta_data -> 'custom_claims' ->> 'address')
       ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
   and not exists (select 1 from public.wallets w where w.user_id = u.id)
on conflict do nothing;

-- Re-derive the cache in case the sync trigger drifted on the hosted copy.
update public.users u
   set funded = exists (select 1 from public.wallets w where w.user_id = u.id);
