-- F2: identity — Users (profile rows keyed to Supabase auth) and Wallets.

-- Profile row for each Supabase auth account. Email lives in auth.users only,
-- which makes the public SELECT of this table safe for leaderboards (F24).
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.user_role not null default 'user',
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- Optional Phantom wallet link (CLAUDE.md: needed only for on-chain
-- commitment verification). One wallet per user for the MVP; a Solana
-- address belongs to at most one account.
create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users (id) on delete cascade,
  address text not null unique,
  chain text not null default 'solana' check (chain = 'solana'),
  -- Devnet-only is enforced by app configuration, not hard-coded here, so
  -- the schema stays usable beyond the hackathon.
  cluster text not null default 'devnet' check (cluster in ('devnet', 'testnet', 'mainnet-beta')),
  -- Set server-side once ownership proof succeeds (F20).
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger wallets_set_updated_at
  before update on public.wallets
  for each row execute function public.set_updated_at();
