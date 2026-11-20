-- SOL-backed live parimutuel wagering — Devnet prototype (2026-11-20).
--
-- Product pivot: wagers are valueless Devnet SOL, moved by a user-signed
-- transaction that carries a System transfer and a Memo commitment atomically.
-- The operator is the fee payer and a required co-signer, so it is the only
-- party that can broadcast a wager — and it co-signs only inside the window,
-- under the round row lock taken here by `wager_reserve`.
--
-- The database is the authoritative ledger. The chain is evidence. Every write
-- path below is a service-role RPC or a service-role table write; clients only
-- read their own rows.
--
-- Rounds keep their existing `round_status` lifecycle (F7). SOL rounds add a
-- one-directional betting sub-state:
--
--   OPEN/LOCKED       betting_phase = 'ante'   (antes accepted until the deadline)
--   RUNNING           betting_phase = 'live'   (eligible users wager during generation)
--   ...closed by the 75% token rule, a finish/failure, or the stall safeguard
--   RUNNING           betting_phase = 'closed' (render, gate, judge may start)
--   EVALUATING+       requires betting_phase = 'closed'
--
-- Points rounds (`wagering_mode = 'points'`) are unaffected.

-- ---------------------------------------------------------------------------
-- 1. Round columns
-- ---------------------------------------------------------------------------
alter table public.rounds
  add column if not exists wagering_mode text not null default 'points',
  add column if not exists betting_phase text not null default 'ante',
  add column if not exists live_started_at timestamptz,
  add column if not exists betting_closed_at timestamptz,
  add column if not exists betting_close_reason text,
  add column if not exists betting_close_model_id uuid references public.llm_models (id),
  add column if not exists betting_close_snapshot jsonb,
  add column if not exists token_budget_per_model integer,
  add column if not exists cutoff_bps integer not null default 7500,
  add column if not exists stall_timeout_seconds integer,
  add column if not exists fee_bps integer not null default 500,
  add column if not exists ante_usd_cents integer not null default 500,
  add column if not exists treasury_address text,
  add column if not exists pool_locked_at timestamptz,
  add column if not exists final_pool jsonb,
  add column if not exists sol_settlement jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rounds_wagering_mode_check') then
    alter table public.rounds add constraint rounds_wagering_mode_check
      check (wagering_mode in ('points', 'devnet_sol'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rounds_betting_phase_check') then
    alter table public.rounds add constraint rounds_betting_phase_check
      check (betting_phase in ('ante', 'live', 'closed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rounds_betting_close_reason_check') then
    alter table public.rounds add constraint rounds_betting_close_reason_check
      check (betting_close_reason is null or betting_close_reason in (
        'token_threshold', 'model_finished', 'model_failed',
        'all_models_stopped', 'stall', 'round_failed', 'admin'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rounds_sol_rules_check') then
    alter table public.rounds add constraint rounds_sol_rules_check check (
      cutoff_bps between 1 and 10000
      and fee_bps between 0 and 2000
      and ante_usd_cents > 0
      and (stall_timeout_seconds is null or stall_timeout_seconds > 0)
      and (token_budget_per_model is null or token_budget_per_model > 0)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rounds_sol_requires_treasury') then
    alter table public.rounds add constraint rounds_sol_requires_treasury check (
      wagering_mode <> 'devnet_sol'
      or (treasury_address is not null and token_budget_per_model is not null)
    );
  end if;
end
$$;

comment on column public.rounds.wagering_mode is
  'points = legacy F18 points pool; devnet_sol = valueless Devnet SOL wagers (2026-11-20 pivot). Mainnet is never a mode.';
comment on column public.rounds.betting_phase is
  'SOL rounds: ante (OPEN, until prediction_deadline = ante deadline) -> live (RUNNING) -> closed. One-directional.';
comment on column public.rounds.prediction_deadline is
  'Points rounds: the stake deadline. SOL rounds: the ANTE deadline; the live cutoff is betting_closed_at.';
comment on column public.rounds.stall_timeout_seconds is
  'Optional safeguard: close live betting when no model has produced a chunk for this long. NULL disables it. The primary cutoff is the 75% token rule.';

-- ---------------------------------------------------------------------------
-- 2. Lifecycle rules for SOL rounds
-- ---------------------------------------------------------------------------
create or replace function public.guard_round_betting()
returns trigger
language plpgsql
as $$
declare
  v_rank_old integer;
  v_rank_new integer;
begin
  if old.wagering_mode = 'points' and new.wagering_mode = 'points' then
    return new;
  end if;

  -- Rule parameters are frozen once a round leaves CREATED.
  if old.status <> 'CREATED' and (
       new.wagering_mode is distinct from old.wagering_mode
    or new.cutoff_bps is distinct from old.cutoff_bps
    or new.fee_bps is distinct from old.fee_bps
    or new.ante_usd_cents is distinct from old.ante_usd_cents
    or new.stall_timeout_seconds is distinct from old.stall_timeout_seconds
    or new.treasury_address is distinct from old.treasury_address
    or new.token_budget_per_model is distinct from old.token_budget_per_model
  ) then
    raise exception 'round % wagering rules are frozen once the round leaves CREATED', old.id
      using errcode = 'P0001';
  end if;

  if new.wagering_mode <> 'devnet_sol' then
    return new;
  end if;

  -- The pipeline starting is the start of live betting.
  if new.status = 'RUNNING' and old.status is distinct from 'RUNNING'
     and new.betting_phase = 'ante' then
    new.betting_phase := 'live';
    new.live_started_at := now();
  end if;

  -- A failed or cancelled round can no longer accept wagers.
  if new.status in ('FAILED', 'CANCELLED') and new.betting_phase <> 'closed' then
    new.betting_phase := 'closed';
    new.betting_closed_at := coalesce(new.betting_closed_at, now());
    new.betting_close_reason := coalesce(new.betting_close_reason, 'round_failed');
  end if;

  -- One direction only.
  v_rank_old := array_position(array['ante', 'live', 'closed'], old.betting_phase);
  v_rank_new := array_position(array['ante', 'live', 'closed'], new.betting_phase);
  if v_rank_new < v_rank_old then
    raise exception 'betting phase cannot move from % back to %',
      old.betting_phase, new.betting_phase using errcode = 'P0001';
  end if;

  -- Nothing outcome-bearing happens while wagers can still be accepted.
  if new.status in ('EVALUATING', 'SETTLED', 'VOIDED', 'ARCHIVED')
     and new.betting_phase <> 'closed' then
    raise exception 'round % cannot reach % while betting is %',
      old.id, new.status, new.betting_phase using errcode = 'P0001';
  end if;

  -- Close record, pool and settlement are write-once.
  if old.betting_closed_at is not null and (
       new.betting_closed_at is distinct from old.betting_closed_at
    or new.betting_close_reason is distinct from old.betting_close_reason
    or new.betting_close_model_id is distinct from old.betting_close_model_id
    or new.betting_close_snapshot is distinct from old.betting_close_snapshot
  ) then
    raise exception 'the betting close record of round % is immutable', old.id
      using errcode = 'P0001';
  end if;
  if old.pool_locked_at is not null and (
       new.pool_locked_at is distinct from old.pool_locked_at
    or new.final_pool is distinct from old.final_pool
  ) then
    raise exception 'the final pool of round % is immutable', old.id using errcode = 'P0001';
  end if;
  if old.sol_settlement is not null
     and new.sol_settlement is distinct from old.sol_settlement then
    raise exception 'the SOL settlement of round % is immutable', old.id using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists rounds_guard_betting on public.rounds;
create trigger rounds_guard_betting
  before update on public.rounds
  for each row execute function public.guard_round_betting();

-- ---------------------------------------------------------------------------
-- 3. Wagers
-- ---------------------------------------------------------------------------
create table if not exists public.wagers (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  model_id uuid not null references public.llm_models (id),
  wallet_address text not null,
  kind text not null check (kind in ('ante', 'live')),
  lamports bigint not null check (lamports > 0),
  -- sha256(roundId|wagerId|modelId|lamports|nonce). The memo carries only this.
  commitment_hash text not null,
  -- The preimage secret. Owner-readable; never written to the chain.
  commitment_nonce text not null,
  status text not null default 'prepared'
    check (status in ('prepared', 'submitted', 'accepted', 'rejected', 'expired')),
  -- The exact message the server built, base64. The signed transaction must
  -- match it byte for byte before the operator co-signs.
  message_b64 text not null,
  prepared_expires_at timestamptz not null,
  signature text unique,
  last_valid_block_height bigint,
  -- Ante pricing evidence (SOL/USD source, price, publish time).
  quote jsonb,
  server_received_at timestamptz,
  accepted_at timestamptz,
  slot bigint,
  block_time timestamptz,
  rejection_reason text,
  -- True when SOL reached the treasury but the wager was not accepted: the
  -- funds must be returned through the payout queue, never kept.
  refund_required boolean not null default false,
  settlement_outcome text check (settlement_outcome in ('won', 'lost', 'refunded')),
  payout_lamports bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wagers_participating_model_fk
    foreign key (round_id, model_id) references public.round_models (round_id, model_id)
);

drop trigger if exists wagers_set_updated_at on public.wagers;
create trigger wagers_set_updated_at
  before update on public.wagers
  for each row execute function public.set_updated_at();

-- One live ante per (round, user): a second can be prepared but never reserved.
create unique index if not exists wagers_one_ante_per_round
  on public.wagers (round_id, user_id)
  where kind = 'ante' and status in ('submitted', 'accepted');

create index if not exists wagers_round_status_idx on public.wagers (round_id, status);
create index if not exists wagers_user_idx on public.wagers (user_id, created_at desc);

alter table public.wagers enable row level security;

drop policy if exists wagers_select_own on public.wagers;
create policy wagers_select_own on public.wagers
  for select to authenticated using (user_id = auth.uid());

revoke insert, update, delete on public.wagers from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Payouts (winnings and refunds) — a durable, retry-safe queue
-- ---------------------------------------------------------------------------
create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  wallet_address text not null,
  kind text not null check (kind in ('winnings', 'refund')),
  lamports bigint not null check (lamports > 0),
  wager_ids uuid[] not null,
  -- payout:<round>:<user>:<kind> for settlement, refund:<wagerId> for strays.
  idempotency_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'confirmed', 'failed', 'uncertain', 'blocked')),
  signature text unique,
  last_valid_block_height bigint,
  attempt integer not null default 0,
  slot bigint,
  last_error text,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists payouts_set_updated_at on public.payouts;
create trigger payouts_set_updated_at
  before update on public.payouts
  for each row execute function public.set_updated_at();

create index if not exists payouts_status_idx on public.payouts (status);
create index if not exists payouts_round_idx on public.payouts (round_id);

alter table public.payouts enable row level security;

drop policy if exists payouts_select_own on public.payouts;
create policy payouts_select_own on public.payouts
  for select to authenticated using (user_id = auth.uid());

revoke insert, update, delete on public.payouts from anon, authenticated;

-- A confirmed payout is final.
create or replace function public.guard_payout_update()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'confirmed' then
    raise exception 'payout % is confirmed and cannot change', old.id using errcode = 'P0001';
  end if;
  if new.lamports is distinct from old.lamports
     or new.wallet_address is distinct from old.wallet_address
     or new.user_id is distinct from old.user_id
     or new.round_id is distinct from old.round_id
     or new.kind is distinct from old.kind then
    raise exception 'payout % amount and recipient are immutable', old.id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists payouts_guard_update on public.payouts;
create trigger payouts_guard_update
  before update on public.payouts
  for each row execute function public.guard_payout_update();

-- ---------------------------------------------------------------------------
-- 5. Reserve a wager: the window check the operator's co-signature depends on
-- ---------------------------------------------------------------------------
-- Devnet safeguards (mirrored in apps/web/lib/server/services/wagering/limits.ts).
create or replace function public.sol_wager_limits()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'minLiveLamports', 5000000,        -- 0.005 SOL
    'maxLiveLamports', 250000000,      -- 0.25 SOL
    'maxLiveWagersPerRound', 10,
    'maxLamportsPerRound', 1000000000  -- 1 SOL, ante included
  );
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
  v_round_total bigint;
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
    if v_wager.lamports < (v_limits->>'minLiveLamports')::bigint
       or v_wager.lamports > (v_limits->>'maxLiveLamports')::bigint then
      raise exception 'a live wager must be between 0.005 and 0.25 SOL' using errcode = '22023';
    end if;
    select count(*) into v_live_count from public.wagers
      where round_id = v_round_id and user_id = v_wager.user_id
        and kind = 'live' and status in ('submitted', 'accepted');
    if v_live_count >= (v_limits->>'maxLiveWagersPerRound')::integer then
      raise exception 'you have reached the live wager limit for this round' using errcode = '22023';
    end if;
  end if;

  select coalesce(sum(lamports), 0) into v_round_total from public.wagers
    where round_id = v_round_id and user_id = v_wager.user_id
      and status in ('submitted', 'accepted');
  if v_round_total + v_wager.lamports > (v_limits->>'maxLamportsPerRound')::bigint then
    raise exception 'this wager would exceed the 1 SOL per-round limit' using errcode = '22023';
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

-- ---------------------------------------------------------------------------
-- 6. Resolve a submitted wager after the chain answered
-- ---------------------------------------------------------------------------
create or replace function public.wager_resolve(
  p_wager_id uuid,
  p_outcome text,
  p_slot bigint default null,
  p_block_time timestamptz default null,
  p_reason text default null,
  p_funds_landed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wager public.wagers%rowtype;
begin
  if p_outcome not in ('accepted', 'rejected', 'expired') then
    raise exception 'invalid wager outcome %', p_outcome using errcode = '22023';
  end if;

  select * into v_wager from public.wagers where id = p_wager_id for update;
  if v_wager.id is null then
    raise exception 'wager % does not exist', p_wager_id using errcode = 'P0002';
  end if;

  if v_wager.status = p_outcome then
    return jsonb_build_object('status', v_wager.status, 'changed', false);
  end if;
  if v_wager.status <> 'submitted' then
    raise exception 'wager % is % and cannot become %', p_wager_id, v_wager.status, p_outcome
      using errcode = 'P0001';
  end if;
  if p_outcome = 'expired' and p_funds_landed then
    raise exception 'an expired wager moved no funds' using errcode = '22023';
  end if;

  update public.wagers
    set status = p_outcome,
        accepted_at = case when p_outcome = 'accepted' then now() else null end,
        slot = coalesce(p_slot, slot),
        block_time = coalesce(p_block_time, block_time),
        rejection_reason = case when p_outcome = 'accepted' then null else p_reason end,
        refund_required = (p_outcome = 'rejected' and p_funds_landed)
    where id = p_wager_id;

  -- The user's signature on a confirmed transfer is the wallet ownership proof.
  if p_outcome = 'accepted' then
    update public.wallets
      set verified_at = coalesce(verified_at, now())
      where user_id = v_wager.user_id and address = v_wager.wallet_address;
  end if;

  return jsonb_build_object('status', p_outcome, 'changed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Close betting (idempotent; first call wins)
-- ---------------------------------------------------------------------------
create or replace function public.close_betting(
  p_round_id uuid,
  p_reason text,
  p_model_id uuid default null,
  p_snapshot jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.rounds%rowtype;
begin
  select * into v_round from public.rounds where id = p_round_id for update;
  if v_round.id is null then
    raise exception 'round % does not exist', p_round_id using errcode = 'P0002';
  end if;

  if v_round.wagering_mode <> 'devnet_sol' then
    return jsonb_build_object('applicable', false);
  end if;

  if v_round.betting_phase = 'closed' then
    return jsonb_build_object(
      'applicable', true, 'closed', true, 'alreadyClosed', true,
      'reason', v_round.betting_close_reason, 'closedAt', v_round.betting_closed_at);
  end if;

  update public.rounds
    set betting_phase = 'closed',
        betting_closed_at = now(),
        betting_close_reason = p_reason,
        betting_close_model_id = p_model_id,
        betting_close_snapshot = p_snapshot
    where id = p_round_id
    returning * into v_round;

  -- Wagers prepared but never submitted can no longer be.
  update public.wagers
    set status = 'expired', rejection_reason = 'betting closed before submission'
    where round_id = p_round_id and status = 'prepared';

  return jsonb_build_object(
    'applicable', true, 'closed', true, 'alreadyClosed', false,
    'reason', v_round.betting_close_reason, 'closedAt', v_round.betting_closed_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Finalize the pool once nothing is in flight
-- ---------------------------------------------------------------------------
create or replace function public.finalize_pool(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.rounds%rowtype;
  v_by_model jsonb;
  v_gross numeric;
  v_count integer;
  v_pool jsonb;
begin
  select * into v_round from public.rounds where id = p_round_id for update;
  if v_round.id is null then
    raise exception 'round % does not exist', p_round_id using errcode = 'P0002';
  end if;
  if v_round.wagering_mode <> 'devnet_sol' then
    raise exception 'round % is not a SOL round', p_round_id using errcode = 'P0001';
  end if;
  if v_round.pool_locked_at is not null then
    return v_round.final_pool;
  end if;
  if v_round.betting_phase <> 'closed' then
    raise exception 'betting is still % for round %', v_round.betting_phase, p_round_id
      using errcode = 'P0001';
  end if;
  if exists (select 1 from public.wagers where round_id = p_round_id and status = 'submitted') then
    raise exception 'round % still has wagers confirming on-chain', p_round_id
      using errcode = 'P0001';
  end if;

  select coalesce(jsonb_object_agg(model_id, total::text), '{}'::jsonb),
         coalesce(sum(total), 0), coalesce(sum(n), 0)
    into v_by_model, v_gross, v_count
    from (
      select model_id, sum(lamports) as total, count(*) as n
        from public.wagers
        where round_id = p_round_id and status = 'accepted'
        group by model_id
    ) t;

  v_pool := jsonb_build_object(
    'grossLamports', v_gross::text,
    'byModel', v_by_model,
    'feeBps', v_round.fee_bps,
    'acceptedWagers', v_count,
    'lockedAt', now()
  );

  update public.rounds set pool_locked_at = now(), final_pool = v_pool where id = p_round_id;
  return v_pool;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Record the SOL settlement (ledger only; transfers are the payout queue)
-- ---------------------------------------------------------------------------
-- p_outcomes: [{wager_id, outcome: won|lost|refunded, lamports}] — one per accepted wager
-- p_payouts:  [{user_id, wallet_address, kind: winnings|refund, lamports, wager_ids: [..]}]
create or replace function public.record_sol_settlement(
  p_round_id uuid,
  p_kind text,
  p_reason text,
  p_winner_model_ids uuid[],
  p_fee_lamports numeric,
  p_outcomes jsonb,
  p_payouts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.rounds%rowtype;
  v_gross numeric;
  v_accepted integer;
  v_supplied integer;
  v_paid numeric;
  v_item jsonb;
  v_rows integer;
  v_settlement jsonb;
  v_queued integer := 0;
begin
  if p_kind not in ('settled', 'refund') then
    raise exception 'settlement kind must be settled or refund' using errcode = '22023';
  end if;

  select * into v_round from public.rounds where id = p_round_id for update;
  if v_round.id is null then
    raise exception 'round % does not exist', p_round_id using errcode = 'P0002';
  end if;
  if v_round.sol_settlement is not null then
    return v_round.sol_settlement || jsonb_build_object('alreadyRecorded', true);
  end if;
  if v_round.pool_locked_at is null then
    raise exception 'the pool of round % is not finalized', p_round_id using errcode = 'P0001';
  end if;
  if v_round.status not in ('EVALUATING', 'CANCELLED') then
    raise exception 'round % is % and cannot be settled', p_round_id, v_round.status
      using errcode = 'P0001';
  end if;
  if v_round.status = 'CANCELLED' and p_kind <> 'refund' then
    raise exception 'a cancelled round can only refund' using errcode = '22023';
  end if;

  v_gross := (v_round.final_pool->>'grossLamports')::numeric;

  select count(*) into v_accepted from public.wagers
    where round_id = p_round_id and status = 'accepted';
  v_supplied := coalesce(jsonb_array_length(p_outcomes), 0);
  if v_accepted <> v_supplied then
    raise exception 'round % has % accepted wager(s) but % outcome(s) were supplied',
      p_round_id, v_accepted, v_supplied using errcode = 'P0001';
  end if;

  select coalesce(sum((x->>'lamports')::numeric), 0) into v_paid
    from jsonb_array_elements(coalesce(p_payouts, '[]'::jsonb)) x;

  if p_kind = 'refund' and (p_fee_lamports <> 0 or v_paid <> v_gross) then
    raise exception 'a refund returns the gross pool exactly with no fee' using errcode = '22023';
  end if;
  if p_kind = 'settled' and v_paid + p_fee_lamports <> v_gross then
    raise exception 'payouts (%) plus fee (%) must equal the gross pool (%)',
      v_paid, p_fee_lamports, v_gross using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_outcomes, '[]'::jsonb))
  loop
    update public.wagers
      set settlement_outcome = v_item->>'outcome',
          payout_lamports = (v_item->>'lamports')::bigint
      where id = (v_item->>'wager_id')::uuid
        and round_id = p_round_id
        and status = 'accepted'
        and settlement_outcome is null;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'wager % is not an unsettled accepted wager of round %',
        v_item->>'wager_id', p_round_id using errcode = 'P0001';
    end if;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p_payouts, '[]'::jsonb))
  loop
    insert into public.payouts (round_id, user_id, wallet_address, kind, lamports, wager_ids, idempotency_key)
    values (
      p_round_id,
      (v_item->>'user_id')::uuid,
      v_item->>'wallet_address',
      v_item->>'kind',
      (v_item->>'lamports')::bigint,
      array(select jsonb_array_elements_text(v_item->'wager_ids')::uuid),
      'payout:' || p_round_id || ':' || (v_item->>'user_id') || ':' || (v_item->>'kind')
    )
    on conflict (idempotency_key) do nothing;
    v_queued := v_queued + 1;
  end loop;

  -- SOL that landed without an accepted wager goes back to its sender.
  insert into public.payouts (round_id, user_id, wallet_address, kind, lamports, wager_ids, idempotency_key)
  select w.round_id, w.user_id, w.wallet_address, 'refund', w.lamports, array[w.id], 'refund:' || w.id
    from public.wagers w
    where w.round_id = p_round_id and w.refund_required
  on conflict (idempotency_key) do nothing;

  v_settlement := jsonb_build_object(
    'kind', p_kind,
    'reason', p_reason,
    'winnerModelIds', to_jsonb(coalesce(p_winner_model_ids, array[]::uuid[])),
    'grossLamports', v_gross::text,
    'feeLamports', p_fee_lamports::text,
    'netLamports', (v_gross - p_fee_lamports)::text,
    'payoutCount', v_queued,
    'recordedAt', now()
  );

  update public.rounds set sol_settlement = v_settlement where id = p_round_id;
  return v_settlement || jsonb_build_object('alreadyRecorded', false);
end;
$$;

-- Service role only: the server authenticates the user, then calls these.
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.wager_reserve(uuid, text, bigint)',
    'public.wager_resolve(uuid, text, bigint, timestamptz, text, boolean)',
    'public.close_betting(uuid, text, uuid, jsonb)',
    'public.finalize_pool(uuid)',
    'public.record_sol_settlement(uuid, text, text, uuid[], numeric, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 10. Outcome-bearing writes wait for the close (SOL rounds)
-- ---------------------------------------------------------------------------
create or replace function public.ensure_betting_closed_for_outcome()
returns trigger
language plpgsql
as $$
declare
  v_mode text;
  v_phase text;
begin
  select wagering_mode, betting_phase into v_mode, v_phase
    from public.rounds where id = new.round_id;
  if v_mode = 'devnet_sol' and v_phase <> 'closed' then
    raise exception 'round % is still taking wagers; % must wait for betting to close',
      new.round_id, tg_table_name using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists judge_verdicts_wait_for_close on public.judge_verdicts;
create trigger judge_verdicts_wait_for_close
  before insert or update on public.judge_verdicts
  for each row execute function public.ensure_betting_closed_for_outcome();

drop trigger if exists round_votes_wait_for_close on public.round_votes;
create trigger round_votes_wait_for_close
  before insert or update on public.round_votes
  for each row execute function public.ensure_betting_closed_for_outcome();
