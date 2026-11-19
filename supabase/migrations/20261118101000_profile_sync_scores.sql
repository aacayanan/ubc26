-- F6: give every account a points row at creation time.
--
-- `public.user_scores` is 1:1 with `public.users` and its own comment says it
-- is "upserted by the profile-sync service (F6)" — but no service ever did.
-- The table was therefore always empty, and every points balance in the UI was
-- the client's `?? 0` fallback: right by accident, and wrong the moment
-- settlement (F18) writes real points against a row that doesn't exist.
--
-- The row is created here, in the same trigger that creates the profile, so
-- both land in one transaction for every signup path. This also has to be a
-- trigger rather than client code: `public.user_scores` has a public SELECT
-- policy but no INSERT policy at all, and settlement writes are service-role
-- only, so no client can ever mint or edit its own score row. A `security
-- definer` function is the only place the row can come from.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id) values (new.id)
  on conflict (id) do nothing;

  insert into public.user_scores (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- Backfill both tables for accounts created before the trigger existed.
insert into public.users (id)
select id from auth.users
on conflict (id) do nothing;

insert into public.user_scores (user_id)
select id from public.users
on conflict (user_id) do nothing;

comment on table public.user_scores is
  'One row per account, created by the handle_new_user() trigger. Total points start at 0 and are only ever written by settlement (F18).';
