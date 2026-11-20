-- Guards for SOL settlement and payout concurrency.

create or replace function public.lock_sol_treasury()
returns void
language sql
security definer
set search_path = public
as $$
  select pg_advisory_xact_lock(hashtext('ai-showdown:sol-treasury'));
$$;

revoke all on function public.lock_sol_treasury() from public, anon, authenticated;
grant execute on function public.lock_sol_treasury() to service_role;

create or replace function public.prevent_sol_settlement_status_change()
returns trigger
language plpgsql
as $$
begin
  if old.sol_settlement is not null
     and new.status is distinct from old.status
     and new.status not in ('SETTLED', 'VOIDED') then
    raise exception 'SOL settlement exists; round outcome cannot be changed';
  end if;
  return new;
end;
$$;

drop trigger if exists rounds_guard_sol_settlement_status
  on public.rounds;
create trigger rounds_guard_sol_settlement_status
  before update on public.rounds
  for each row execute function public.prevent_sol_settlement_status_change();
