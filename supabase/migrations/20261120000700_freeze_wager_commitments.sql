-- F20: a wager's commitment can never be rewritten (2026-11-20).
--
-- The memo on Devnet carries `commitment_hash`; verification recomputes it
-- from the stored preimage (round, wager, model, lamports, nonce). If any of
-- those could change after the wager was created, a stored row could be made
-- to disagree with the chain, or to agree with a different pick. Clients
-- already hold no write grant on `wagers`; this closes the server-side path
-- too, as defense in depth.
--
--   - commitment and preimage columns: immutable from insert
--   - signature: write-once (set when the signed transaction is reserved)
--   - settlement_outcome / payout_lamports: write-once (set at settlement)
--
-- No existing write path updates any of these after the fact (wager_reserve
-- sets the signature once on prepared -> submitted; record_sol_settlement
-- writes the outcome once, guarded by `settlement_outcome is null`).

create or replace function public.guard_wager_commitment()
returns trigger
language plpgsql
as $$
begin
  if new.round_id is distinct from old.round_id
     or new.user_id is distinct from old.user_id
     or new.model_id is distinct from old.model_id
     or new.wallet_address is distinct from old.wallet_address
     or new.kind is distinct from old.kind
     or new.lamports is distinct from old.lamports
     or new.commitment_hash is distinct from old.commitment_hash
     or new.commitment_nonce is distinct from old.commitment_nonce
     or new.message_b64 is distinct from old.message_b64
  then
    raise exception 'wager % commitment is immutable', old.id
      using errcode = 'P0001';
  end if;

  if old.signature is not null
     and new.signature is distinct from old.signature then
    raise exception 'wager % signature is write-once', old.id
      using errcode = 'P0001';
  end if;

  if old.settlement_outcome is not null and (
       new.settlement_outcome is distinct from old.settlement_outcome
    or new.payout_lamports is distinct from old.payout_lamports
  ) then
    raise exception 'wager % settlement is final', old.id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists wagers_guard_commitment on public.wagers;
create trigger wagers_guard_commitment
  before update on public.wagers
  for each row execute function public.guard_wager_commitment();

comment on function public.guard_wager_commitment() is
  'F20: commitment + preimage columns immutable; signature and settlement write-once.';
