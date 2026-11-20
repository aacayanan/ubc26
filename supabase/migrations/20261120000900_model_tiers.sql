-- Model tiers: a round is priced by the tier its competitors belong to
-- (2026-11-20).
--
-- The lineup grew from three models to four rungs of capability. A buy-in that
-- is the same $5 for a cheap model and an exclusive one prices the cheap round
-- out of reach and the exclusive one almost free, so the ante now follows the
-- tier: cheap $2, mid $4, frontier $6, exclusive $10.
--
-- Scope rules this migration enforces, in the database rather than in a
-- form-callback:
--
--   * **One tier per round.** A round is the ladder step, not the model. Every
--     participating model must belong to the same tier, and that tier must be
--     the one the round asks for. Mixing tiers would make the ante ambiguous
--     and let a $10 pick sit in the same pool as a $2 one.
--   * **The ante is derived, not typed.** `rounds.ante_usd_cents` is set from
--     `model_tiers.ante_usd_cents` at creation, so the price a backer sees is
--     the ladder's price and cannot drift from it.
--   * **The tier is frozen with the round.** Like the other SOL rule
--     parameters, `rounds.tier` cannot change once the round leaves CREATED.
--
-- `rounds.ante_usd_cents` stays authoritative for everything downstream
-- (quoting, prepare, the UI). `rounds.tier` is the ladder step that produced
-- it, kept so a settled round can still say which rung it was.

-- ---------------------------------------------------------------------------
-- 1. The ladder
-- ---------------------------------------------------------------------------
create table if not exists public.model_tiers (
  -- Stable app-level identifier; also what `llm_models.tier` and `rounds.tier`
  -- reference.
  slug text primary key,
  label text not null,
  -- The buy-in for a round at this tier, in USD cents. A wager is still
  -- recorded in lamports; this is the price the quote is built from.
  ante_usd_cents integer not null check (ante_usd_cents > 0),
  -- Cheapest first; the order the ladder is presented in.
  sort_order integer not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists model_tiers_set_updated_at on public.model_tiers;
create trigger model_tiers_set_updated_at
  before update on public.model_tiers
  for each row execute function public.set_updated_at();

-- The four rungs decided 2026-11-20. Re-running is safe and updates the price
-- in place, so raising a tier's buy-in is one statement here.
insert into public.model_tiers (slug, label, ante_usd_cents, sort_order) values
  ('cheap',     'Cheap',     200,  1),
  ('mid',       'Mid',       400,  2),
  ('frontier',  'Frontier',  600,  3),
  ('exclusive', 'Exclusive', 1000, 4)
on conflict (slug) do update set
  label = excluded.label,
  ante_usd_cents = excluded.ante_usd_cents,
  sort_order = excluded.sort_order;

comment on table public.model_tiers is
  'The buy-in ladder: a round is priced by the tier its competitors share. Points rounds and legacy rounds may carry no tier.';
comment on column public.model_tiers.ante_usd_cents is
  'The round buy-in for this tier, in USD cents. Copied to rounds.ante_usd_cents at creation and never re-read afterwards.';

-- ---------------------------------------------------------------------------
-- 2. The tier on models and rounds
-- ---------------------------------------------------------------------------
alter table public.llm_models
  add column if not exists tier text references public.model_tiers (slug);

comment on column public.llm_models.tier is
  'The buy-in rung this model competes in. NULL for a judge and for legacy rows; a round requires a tier on every competitor it seats (create_sol_competition).';

alter table public.rounds
  add column if not exists tier text references public.model_tiers (slug);

comment on column public.rounds.tier is
  'For SOL rounds: the ladder step whose price is rounds.ante_usd_cents. Frozen once the round leaves CREATED.';

create index if not exists llm_models_tier_idx
  on public.llm_models (tier, is_active, sort_order);

-- The tier cannot be swapped under a round that is already taking wagers: the
-- price, and therefore every wager in it, was set from this value.
create or replace function public.guard_round_tier()
returns trigger
language plpgsql
as $$
begin
  if old.tier is not null
     and old.status <> 'CREATED'
     and new.tier is distinct from old.tier then
    raise exception 'the tier of round % is frozen once it leaves CREATED', old.id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists rounds_guard_tier on public.rounds;
create trigger rounds_guard_tier
  before update on public.rounds
  for each row execute function public.guard_round_tier();

-- ---------------------------------------------------------------------------
-- 3. Create a SOL round at a tier
-- ---------------------------------------------------------------------------
-- Replaces the previous 11-argument body: `p_ante_usd_cents` is gone because
-- the price now comes from the tier. Nothing in the repo passed that argument
-- by name, so the drop is a rename rather than a breaking change; the new
-- `p_tier` is optional, since the participants already name the tier.
drop function if exists public.create_sol_competition(
  text, uuid, uuid[], timestamptz, uuid, text, integer, integer, integer, integer, integer);

create or replace function public.create_sol_competition(
  p_slug text,
  p_challenge_id uuid,
  p_model_ids uuid[],
  p_prediction_deadline timestamptz,
  p_created_by uuid,
  p_treasury_address text,
  p_token_budget_per_model integer,
  p_fee_bps integer default 500,
  p_cutoff_bps integer default 7500,
  p_tier text default null,
  p_stall_timeout_seconds integer default null
)
returns public.rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.rounds;
  v_tiers text[];
  v_tier text;
  v_ante_usd_cents integer;
begin
  if nullif(trim(p_slug), '') is null then
    raise exception 'competition slug is required' using errcode = '22023';
  end if;
  if p_prediction_deadline <= now() then
    raise exception 'the ante deadline must be in the future' using errcode = '22023';
  end if;
  if p_model_ids is null or array_length(p_model_ids, 1) < 2
     or (select count(distinct m) from unnest(p_model_ids) m) <> cardinality(p_model_ids) then
    raise exception 'at least two unique participating models are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.challenges where id = p_challenge_id and status = 'published') then
    raise exception 'challenge must be published' using errcode = '22023';
  end if;
  if (select count(*) from public.llm_models
      where id = any(p_model_ids) and is_active and role = 'competitor')
     <> cardinality(p_model_ids) then
    raise exception 'all participating models must be active competitors' using errcode = '22023';
  end if;
  if nullif(trim(p_treasury_address), '') is null then
    raise exception 'a SOL round needs a treasury address' using errcode = '22023';
  end if;

  -- One tier per round. `array_agg(distinct …)` over a NULL tier yields
  -- {NULL}, which is why an unseated model is refused rather than silently
  -- priced at nothing.
  select array_agg(distinct tier) into v_tiers
    from public.llm_models where id = any(p_model_ids);

  if v_tiers is null or array_length(v_tiers, 1) <> 1 or v_tiers[1] is null then
    raise exception 'every participating model must belong to one tier'
      using errcode = '22023';
  end if;
  v_tier := v_tiers[1];

  if p_tier is not null and p_tier <> v_tier then
    raise exception 'the round tier (%) does not match its models'' tier (%)',
      p_tier, v_tier using errcode = '22023';
  end if;

  select ante_usd_cents into v_ante_usd_cents
    from public.model_tiers where slug = v_tier;
  if v_ante_usd_cents is null then
    raise exception 'tier % has no price', v_tier using errcode = '22023';
  end if;

  insert into public.rounds (
    slug, challenge_id, prediction_opens_at, prediction_deadline, created_by,
    wagering_mode, treasury_address, token_budget_per_model, fee_bps, cutoff_bps,
    ante_usd_cents, tier, stall_timeout_seconds
  ) values (
    trim(p_slug), p_challenge_id, now(), p_prediction_deadline, p_created_by,
    'devnet_sol', trim(p_treasury_address), p_token_budget_per_model, p_fee_bps, p_cutoff_bps,
    v_ante_usd_cents, v_tier, p_stall_timeout_seconds
  )
  returning * into v_round;

  insert into public.round_models (round_id, model_id, ordinal)
  select v_round.id, model_id, ordinal
    from unnest(p_model_ids) with ordinality as models(model_id, ordinal);

  perform public.transition_round(
    v_round.id, 'OPEN', 'CREATED', 'SOL competition created by administrator', p_created_by);

  select * into v_round from public.rounds where id = v_round.id;
  return v_round;
end;
$$;

revoke all on function public.create_sol_competition(
  text, uuid, uuid[], timestamptz, uuid, text, integer, integer, integer, text, integer
) from public, anon, authenticated;
grant execute on function public.create_sol_competition(
  text, uuid, uuid[], timestamptz, uuid, text, integer, integer, integer, text, integer
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Read access
-- ---------------------------------------------------------------------------
alter table public.model_tiers enable row level security;

drop policy if exists model_tiers_public_read on public.model_tiers;
create policy model_tiers_public_read on public.model_tiers
  for select using (true);

-- Writes are service-role only, like every other catalog table.
revoke insert, update, delete on public.model_tiers from anon, authenticated;
