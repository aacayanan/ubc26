-- F2: catalogs — LLM Models, Challenges, and their Test Cases.
-- Seed data (the three OpenRouter models, the challenge bank) is owned by F12;
-- these migrations stay seed-free so a fresh apply is pure schema.

create table public.llm_models (
  id uuid primary key default gen_random_uuid(),
  -- Stable app-level identifier, e.g. "cheapest-3-a".
  slug text not null unique,
  name text not null,
  provider text not null default 'openrouter',
  -- Exact OpenRouter model ID (F16 records it per execution).
  openrouter_model_id text not null unique,
  -- Default generation params snapshot (temperature, max_tokens, …).
  config jsonb not null default '{}'::jsonb,
  -- The lineup is chosen at config time (REQUIREMENTS.md open item 2).
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger llm_models_set_updated_at
  before update on public.llm_models
  for each row execute function public.set_updated_at();

create index llm_models_active_order_idx
  on public.llm_models (is_active, sort_order);

create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  -- Versioned seeds (F12): re-seeding bumps the version; rounds pin a
  -- specific challenge_id so old rounds keep their exact challenge.
  version integer not null default 1 check (version >= 1),
  title text not null,
  prompt text not null,
  starter_code text not null default '',
  -- MVP is Python-only (REQUIREMENTS.md out-of-scope list).
  language text not null default 'python' check (language = 'python'),
  -- Drafts are incomplete/invalid and cannot be selected for a round (F12).
  status public.challenge_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slug, version)
);

create trigger challenges_set_updated_at
  before update on public.challenges
  for each row execute function public.set_updated_at();

create index challenges_status_idx on public.challenges (status);

create table public.test_cases (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  -- Hidden cases are server-only: never exposed through the API (F12).
  kind public.test_kind not null,
  ordinal integer not null check (ordinal >= 1),
  input text not null default '',
  expected_output text not null,
  timeout_ms integer not null default 5000 check (timeout_ms > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (challenge_id, ordinal)
);

create trigger test_cases_set_updated_at
  before update on public.test_cases
  for each row execute function public.set_updated_at();
