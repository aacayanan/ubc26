-- F8: create the user profile automatically and atomically create/open rounds.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.email)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill accounts that already existed before F8's profile trigger was added.
insert into public.users (id, display_name)
select
  u.id,
  coalesce(u.raw_user_meta_data ->> 'display_name', u.email)
from auth.users u
on conflict (id) do nothing;

-- F8 demo catalog. F12 can replace or expand these predefined records later.
insert into public.llm_models (
  slug,
  name,
  openrouter_model_id,
  is_active,
  sort_order
) values
  ('demo-gpt', 'Demo GPT', 'demo/gpt', true, 10),
  ('demo-claude', 'Demo Claude', 'demo/claude', true, 20),
  ('demo-gemini', 'Demo Gemini', 'demo/gemini', true, 30)
on conflict (slug) do update
set
  name = excluded.name,
  is_active = true;

insert into public.challenges (
  slug,
  version,
  title,
  prompt,
  starter_code,
  language,
  status,
  entry_point
) values (
  'demo-fizzbuzz',
  1,
  'FizzBuzz',
  'Given an integer n, print one line for each number from 1 through n. Print "Fizz" for multiples of 3, "Buzz" for multiples of 5, and "FizzBuzz" for multiples of both.',
  'def fizzbuzz(n):\n    pass\n',
  'python',
  'published',
  -- F13 (20261118101300) requires a published challenge to declare the
  -- function the sandbox calls. This demo challenge's starter code defines
  -- `fizzbuzz`, so that is its entry point. Without it this insert violates
  -- challenges_published_has_entry_point and aborts the whole migration.
  'fizzbuzz'
)
on conflict (slug, version) do update
set
  title = excluded.title,
  prompt = excluded.prompt,
  starter_code = excluded.starter_code,
  entry_point = excluded.entry_point,
  status = 'published';

create or replace function public.create_competition(
  p_slug text,
  p_challenge_id uuid,
  p_model_ids uuid[],
  p_prediction_opens_at timestamptz,
  p_prediction_deadline timestamptz,
  p_created_by uuid
)
returns public.rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.rounds;
  v_model_count integer;
begin
  if nullif(trim(p_slug), '') is null then
    raise exception 'competition slug is required' using errcode = '22023';
  end if;

  if p_prediction_deadline <= coalesce(p_prediction_opens_at, now()) then
    raise exception 'prediction deadline must be after the opening time'
      using errcode = '22023';
  end if;

  if p_prediction_deadline <= now() then
    raise exception 'prediction deadline must be in the future'
      using errcode = '22023';
  end if;

  if p_model_ids is null or array_length(p_model_ids, 1) < 2 then
    raise exception 'at least two participating models are required'
      using errcode = '22023';
  end if;

  select count(distinct model_id)
    into v_model_count
    from unnest(p_model_ids) as model_id;

  if v_model_count <> cardinality(p_model_ids) then
    raise exception 'participating models must be unique' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.challenges
     where id = p_challenge_id
       and status = 'published'
  ) then
    raise exception 'challenge must be published' using errcode = '22023';
  end if;

  if (
    select count(*)
      from public.llm_models
     where id = any(p_model_ids)
       and is_active
  ) <> cardinality(p_model_ids) then
    raise exception 'all participating models must be active'
      using errcode = '22023';
  end if;

  insert into public.rounds (
    slug,
    challenge_id,
    prediction_opens_at,
    prediction_deadline,
    created_by
  ) values (
    trim(p_slug),
    p_challenge_id,
    coalesce(p_prediction_opens_at, now()),
    p_prediction_deadline,
    p_created_by
  )
  returning * into v_round;

  insert into public.round_models (round_id, model_id, ordinal)
  select v_round.id, model_id, row_number() over ()
    from unnest(p_model_ids) with ordinality as models(model_id, ordinal);

  perform public.transition_round(
    v_round.id,
    'OPEN',
    'CREATED',
    'Competition created by administrator',
    p_created_by
  );

  select * into v_round from public.rounds where id = v_round.id;
  return v_round;
end;
$$;

revoke all on function public.create_competition(
  text, uuid, uuid[], timestamptz, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.create_competition(
  text, uuid, uuid[], timestamptz, timestamptz, uuid
) to service_role;
