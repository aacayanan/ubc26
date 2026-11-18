-- F2: Blockchain Transactions — scope-agnostic records for Solana Devnet.
-- G1 (Anchor vs lightweight tx records) is gated until M5; this table fits
-- both: generic columns now, program-specific data lives in payload.

create table public.blockchain_transactions (
  id uuid primary key default gen_random_uuid(),
  -- One key per logical action; retries reuse it, so a duplicate insert
  -- hits 23505 instead of creating a misleading second record (F21).
  idempotency_key text not null unique,
  -- Solana transaction signature; null while pending/failed pre-submit.
  signature text unique,
  purpose public.tx_purpose not null,
  status public.tx_status not null default 'pending',
  -- Correlation to off-chain data (F20–F22).
  user_id uuid references public.users (id) on delete set null,
  round_id uuid references public.rounds (id) on delete set null,
  wallet_address text,
  -- Anchor program id when G1 lands; null for lightweight tx records.
  program_id text,
  slot bigint,
  -- Memo content now; future Anchor account data later.
  payload jsonb not null default '{}'::jsonb,
  error text,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger blockchain_transactions_set_updated_at
  before update on public.blockchain_transactions
  for each row execute function public.set_updated_at();

create index blockchain_transactions_round_purpose_idx
  on public.blockchain_transactions (round_id, purpose);
create index blockchain_transactions_user_created_idx
  on public.blockchain_transactions (user_id, created_at);
create index blockchain_transactions_status_idx
  on public.blockchain_transactions (status);
