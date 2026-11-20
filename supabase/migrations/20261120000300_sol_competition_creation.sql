-- SOL rounds are created with their wagering rules in place (2026-11-20).
--
-- `create_competition` (F8) inserts and immediately opens a round; the rules
-- freeze once a round leaves CREATED, so they cannot be patched in afterwards.
-- This wrapper validates through the same rules, inserts a CREATED round with
-- the SOL columns set, and only then opens it.

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
  p_ante_usd_cents integer default 500,
  p_stall_timeout_seconds integer default null
)
returns public.rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.rounds;
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
  if (select count(*) from public.llm_models where id = any(p_model_ids) and is_active)
     <> cardinality(p_model_ids) then
    raise exception 'all participating models must be active' using errcode = '22023';
  end if;
  if nullif(trim(p_treasury_address), '') is null then
    raise exception 'a SOL round needs a treasury address' using errcode = '22023';
  end if;

  insert into public.rounds (
    slug, challenge_id, prediction_opens_at, prediction_deadline, created_by,
    wagering_mode, treasury_address, token_budget_per_model, fee_bps, cutoff_bps,
    ante_usd_cents, stall_timeout_seconds
  ) values (
    trim(p_slug), p_challenge_id, now(), p_prediction_deadline, p_created_by,
    'devnet_sol', trim(p_treasury_address), p_token_budget_per_model, p_fee_bps, p_cutoff_bps,
    p_ante_usd_cents, p_stall_timeout_seconds
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
  text, uuid, uuid[], timestamptz, uuid, text, integer, integer, integer, integer, integer
) from public, anon, authenticated;

grant execute on function public.create_sol_competition(
  text, uuid, uuid[], timestamptz, uuid, text, integer, integer, integer, integer, integer
) to service_role;
