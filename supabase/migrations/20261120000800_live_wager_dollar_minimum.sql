-- Live wager amounts (2026-11-20): $3 minimum, no maximum.
--
-- After the $5 ante, each live wager must be worth at least $3 in SOL at the
-- SOL/USD reference price. That floor is enforced when the server prepares the
-- wager (lib/server/services/wagering/wagers.ts), because the database has no
-- price; the quote is stored with the wager as evidence, and wager_reserve
-- only co-signs bytes identical to the prepared ones, so the amount cannot be
-- raised or lowered after the check.
--
-- Removed: the fixed 0.005-0.25 SOL live bounds and the 1 SOL per-account
-- per-round cap. Kept: at most 10 live wagers per account per round (a count,
-- not an amount), one ante per account per round, and every window rule.
--
-- wager_reserve is re-created (not only sol_wager_limits) so every pooled
-- session recompiles it rather than reusing a cached, constant-folded limit.

create or replace function public.sol_wager_limits()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('maxLiveWagersPerRound', 10);
$$;

create or replace function public.wager_reserve(
  p_wager_id uuid,
  p_signature text,
  p_last_valid_block_height bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
  v_round public.rounds%rowtype;
  v_wager public.wagers%rowtype;
  v_role public.user_role;
  v_practice boolean;
  v_limits jsonb := public.sol_wager_limits();
  v_live_count integer;
begin
  select round_id into v_round_id from public.wagers where id = p_wager_id;
  if v_round_id is null then
    raise exception 'wager % does not exist', p_wager_id using errcode = 'P0002';
  end if;

  -- Same lock as close_betting: a wager is either reserved before the close or
  -- refused after it, never both.
  select * into v_round from public.rounds where id = v_round_id for update;
  select * into v_wager from public.wagers where id = p_wager_id for update;

  if v_wager.status = 'submitted' and v_wager.signature = p_signature then
    return jsonb_build_object('reserved', true, 'alreadyReserved', true);
  end if;

  if v_wager.status <> 'prepared' then
    raise exception 'wager % is % and cannot be submitted', p_wager_id, v_wager.status
      using errcode = 'P0001';
  end if;

  if v_wager.prepared_expires_at < now() then
    update public.wagers set status = 'expired', rejection_reason = 'prepared wager expired'
      where id = p_wager_id;
    raise exception 'this wager expired before it was signed; prepare it again'
      using errcode = 'P0001';
  end if;

  if v_round.wagering_mode <> 'devnet_sol' then
    raise exception 'round % does not take SOL wagers', v_round_id using errcode = 'P0001';
  end if;

  select role, practice_mode into v_role, v_practice from public.users where id = v_wager.user_id;
  if v_role = 'admin' then
    raise exception 'staff accounts cannot wager' using errcode = '42501';
  end if;
  if v_practice then
    raise exception 'practice mode accounts can watch and vote but not wager' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.wagers
    where user_id = v_wager.user_id and status = 'submitted' and id <> p_wager_id
  ) then
    raise exception 'another wager of yours is still confirming; wait for it first'
      using errcode = '22023';
  end if;

  if v_wager.kind = 'ante' then
    if v_round.status <> 'OPEN' or v_round.betting_phase <> 'ante'
       or now() > v_round.prediction_deadline then
      raise exception 'the ante window for round % has closed', v_round_id using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.wagers
      where round_id = v_round_id and user_id = v_wager.user_id and kind = 'ante'
        and status in ('submitted', 'accepted')
    ) then
      raise exception 'you have already placed the ante for this round' using errcode = '23505';
    end if;
  else
    if v_round.status <> 'RUNNING' or v_round.betting_phase <> 'live' then
      raise exception 'live betting is not open for round %', v_round_id using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from public.wagers
      where round_id = v_round_id and user_id = v_wager.user_id
        and kind = 'ante' and status = 'accepted'
    ) then
      raise exception 'place the ante before the deadline to join live betting'
        using errcode = '42501';
    end if;
    -- The $3 minimum is checked at prepare against the SOL/USD reference
    -- price; the signed bytes must equal the prepared ones, so the amount
    -- cannot change after that check. No per-wager maximum.
    if v_wager.lamports <= 0 then
      raise exception 'a live wager must move some SOL' using errcode = '22023';
    end if;
    select count(*) into v_live_count from public.wagers
      where round_id = v_round_id and user_id = v_wager.user_id
        and kind = 'live' and status in ('submitted', 'accepted');
    if v_live_count >= (v_limits->>'maxLiveWagersPerRound')::integer then
      raise exception 'you have reached the live wager limit for this round' using errcode = '22023';
    end if;
  end if;

  update public.wagers
    set status = 'submitted',
        signature = p_signature,
        last_valid_block_height = p_last_valid_block_height,
        server_received_at = now()
    where id = p_wager_id;

  return jsonb_build_object('reserved', true, 'alreadyReserved', false);
end;
$$;

