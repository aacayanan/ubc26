-- F17: the chunked generation and render pipeline.
--
-- F17 turns a LOCKED round into per-model verdicts. It needs four things the
-- schema could not express before this migration:
--
--   1. **A judge is a distinct kind of model.** F31 introduces a vision model
--      that rules on renders; until now `llm_models` had no way to say "this row
--      does not compete", and `getActiveLineup()` returned every active row — so
--      an active judge would silently have competed as a fourth competitor.
--   2. **Generation happens in durable chunks.** A chunk is a resumable unit of
--      generation with its own token cap. Storing them makes "restart without
--      re-spending tokens on already-rendered chunks" true rather than
--      aspirational: the next run reads what exists and continues.
--   3. **Partial renders are not artifacts.** A half-written renderer usually
--      does not parse; rendering it is entertainment, not evidence. Previews
--      therefore live in their own table and never touch
--      `rendered_artifacts`, which stays one gated row per execution (F14).
--   4. **A judge ruling is a first-class record.** The results view (F19) has to
--      explain *why* a model conformed, so the per-criterion verdict is stored
--      structurally rather than as prose in `response_meta`.
--
-- Enum values are added here but never *used* in this file: PostgreSQL refuses
-- to use a new enum value in the transaction that added it, and the `'judge'`
-- run type is only ever written by the application afterwards.

-- ---------------------------------------------------------------------------
-- 1. Judges are models with a role.
--
-- Default `competitor` so every existing row keeps competing exactly as before
-- and this migration cannot silently shrink a lineup.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'llm_models'
      and column_name = 'role'
  ) then
    alter table public.llm_models add column role text not null default 'competitor';
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'llm_models_role_check'
      and conrelid = 'public.llm_models'::regclass
  ) then
    alter table public.llm_models
      add constraint llm_models_role_check
      check (role in ('competitor', 'judge'));
  end if;
end
$$;

comment on column public.llm_models.role is
  'competitor = part of the lineup that renders for the crowd; judge = the vision model that rules on conformance (F31). Only competitors are returned by getActiveLineup().';

-- One active judge at a time. Two would make the verdict depend on query order.
create unique index if not exists llm_models_single_active_judge
  on public.llm_models (role)
  where role = 'judge' and is_active;

alter type public.execution_run_type add value if not exists 'judge';

-- ---------------------------------------------------------------------------
-- 2. Chunked generation.
--
-- `model_executions` stays one row per (round, model, run_type, attempt): the
-- generation execution owns its chunks rather than becoming one row per chunk.
-- The chunk policy that produced them (token cap, max chunks, template version)
-- is recorded in that execution's `config` snapshot, so a run is reproducible
-- even after the policy constant changes.
-- ---------------------------------------------------------------------------
create table if not exists public.generation_chunks (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null
    references public.model_executions (id) on delete cascade,
  -- 0-based: chunk 0 is the answer to the brief, chunk n is a continuation.
  chunk_index integer not null check (chunk_index >= 0),
  -- The code this chunk added, verbatim. Concatenated in index order it is the
  -- full renderer, which is why a resume never needs to re-ask for a chunk.
  source text not null,
  -- Per-chunk fairness record: which prompt template, and a hash of the exact
  -- messages sent for this chunk (the first chunk is the brief; later ones
  -- carry the code so far).
  prompt_template_version text not null,
  prompt_sha256 text not null,
  finish_reason text,
  -- Provider usage for this chunk alone, when reported.
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  -- HTTP attempts this chunk consumed (F16 retries ride on one chunk).
  attempt_count smallint not null default 1
    constraint generation_chunks_attempt_count_positive check (attempt_count >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The resume latch: re-running a chunk updates its row instead of appending a
  -- second copy, so the concatenation can never interleave a duplicate.
  unique (execution_id, chunk_index)
);

drop trigger if exists generation_chunks_set_updated_at on public.generation_chunks;
create trigger generation_chunks_set_updated_at
  before update on public.generation_chunks
  for each row execute function public.set_updated_at();

comment on table public.generation_chunks is
  'F17: the durable chunks one generation execution was built from. Concatenated in chunk_index order they are the model''s full renderer, which is what makes an interrupted generation resumable.';

-- ---------------------------------------------------------------------------
-- 3. Progressive render previews.
--
-- Deliberately separate from `rendered_artifacts`: a preview is of a partial
-- source at reduced geometry, was never gated, and is never judged. Keeping it
-- out of the artifact table is what preserves "one gated artifact per
-- execution" (F14) and stops a half-written render from being mistaken for
-- evidence.
-- ---------------------------------------------------------------------------
create table if not exists public.render_previews (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null
    references public.model_executions (id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  -- Whether the partial source looked syntactically complete enough to try.
  -- False is the "compiling…" state: the code is shown growing, nothing failed.
  parse_ok boolean not null,
  -- Whether a render was attempted and what came back. `rendered = false` with
  -- `parse_ok = true` is a partial chunk that parsed but threw — still not a
  -- round failure (a later chunk may fix it).
  rendered boolean not null default false,
  error text,
  -- [{index, png(base64), blank, distinctColors, width, height}], same shape as
  -- `rendered_artifacts.frames` but at preview geometry and few frames.
  frames jsonb not null default '[]'::jsonb,
  image_digest text,
  wall_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A resume re-renders nothing that already exists.
  unique (execution_id, chunk_index)
);

drop trigger if exists render_previews_set_updated_at on public.render_previews;
create trigger render_previews_set_updated_at
  before update on public.render_previews
  for each row execute function public.set_updated_at();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'render_previews_frames_array'
      and conrelid = 'public.render_previews'::regclass
  ) then
    alter table public.render_previews
      add constraint render_previews_frames_array
      check (jsonb_typeof(frames) = 'array');
  end if;
end
$$;

create index if not exists render_previews_execution_idx
  on public.render_previews (execution_id, chunk_index);

comment on table public.render_previews is
  'F17: the progressive render of a partially-generated renderer, for the audience to watch. Never gated, never judged, and never a round failure.';

-- ---------------------------------------------------------------------------
-- 4. Judge rulings.
--
-- One row per (judge execution, subject model). The judge execution is a
-- `model_executions` row with `run_type = 'judge'` and `model_id` = the judge,
-- so the call shares F16's retry/forfeit machinery and diagnostics; this table
-- holds the part of the answer the results view renders.
--
-- `subject_model_id` is stored explicitly rather than inferred from `attempt`
-- (which the judge execution uses as a 1-based position, because a round has one
-- judge but several subjects). Querying verdicts must not depend on decoding a
-- counter.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'model_executions'
      and column_name = 'subject_model_id'
  ) then
    alter table public.model_executions
      add column subject_model_id uuid references public.llm_models (id);
  end if;
end
$$;

comment on column public.model_executions.subject_model_id is
  'For run_type = ''judge'': the competitor whose render was judged. NULL for generation runs, which are their own subject.';

create table if not exists public.judge_verdicts (
  id uuid primary key default gen_random_uuid(),
  -- The judge execution that produced this ruling (the F16 call record).
  execution_id uuid not null
    references public.model_executions (id) on delete cascade,
  round_id uuid not null references public.rounds (id) on delete cascade,
  -- The model whose frames were judged.
  subject_model_id uuid not null references public.llm_models (id),
  -- Mirrors ModelConformance's judge-decidable values (F15): a judge either
  -- rules, or is unavailable — it never silently becomes a pass or a fail.
  verdict text not null check (verdict in ('conformed', 'not_conformed', 'unavailable')),
  -- Plain-language summary, safe to show a viewer (F19).
  reason text not null,
  -- Per-criterion outcomes: [{id, question, passed, reason}] from the brief's
  -- rubric. Empty when the judge was unavailable.
  criteria jsonb not null default '[]'::jsonb,
  -- The rubric revision this ruling was made against, so a stored verdict is
  -- explainable even after the brief is re-versioned.
  rubric_sha256 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Re-judging stored frames updates the ruling rather than stacking copies.
  unique (execution_id)
);

drop trigger if exists judge_verdicts_set_updated_at on public.judge_verdicts;
create trigger judge_verdicts_set_updated_at
  before update on public.judge_verdicts
  for each row execute function public.set_updated_at();

-- One ruling per subject per round: a re-judge replaces, never duplicates.
create unique index if not exists judge_verdicts_round_subject_unique
  on public.judge_verdicts (round_id, subject_model_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'judge_verdicts_criteria_array'
      and conrelid = 'public.judge_verdicts'::regclass
  ) then
    alter table public.judge_verdicts
      add constraint judge_verdicts_criteria_array
      check (jsonb_typeof(criteria) = 'array');
  end if;
end
$$;

comment on table public.judge_verdicts is
  'F31/F17: the judge model''s structured conformance ruling on one model''s rendered frames, stored in a form the results view can explain.';

-- ---------------------------------------------------------------------------
-- 5. Row-level security: the two clocks hold for the new tables too.
--
-- Nothing a viewer could read may exist before the betting window closes. The
-- rendered_artifacts policy already scopes on round status; these mirror it
-- rather than trusting every route to filter. Writes stay service-role-only
-- (no write policy), matching model_executions and rendered_artifacts.
-- ---------------------------------------------------------------------------
alter table public.generation_chunks enable row level security;
alter table public.render_previews enable row level security;
alter table public.judge_verdicts enable row level security;

drop policy if exists generation_chunks_public_read on public.generation_chunks;
create policy generation_chunks_public_read on public.generation_chunks
  for select using (
    exists (
      select 1
      from public.model_executions e
      join public.rounds r on r.id = e.round_id
      where e.id = generation_chunks.execution_id
        and r.status not in ('CREATED', 'OPEN')
    )
  );

drop policy if exists render_previews_public_read on public.render_previews;
create policy render_previews_public_read on public.render_previews
  for select using (
    exists (
      select 1
      from public.model_executions e
      join public.rounds r on r.id = e.round_id
      where e.id = render_previews.execution_id
        and r.status not in ('CREATED', 'OPEN')
    )
  );

drop policy if exists judge_verdicts_public_read on public.judge_verdicts;
create policy judge_verdicts_public_read on public.judge_verdicts
  for select using (
    exists (
      select 1 from public.rounds r
      where r.id = judge_verdicts.round_id
        and r.status not in ('CREATED', 'OPEN')
    )
  );

-- ---------------------------------------------------------------------------
-- 6. A judge cannot be seated as a competitor.
--
-- create_competition validated "is_active" only, so once the judge row is
-- activated it would be selectable as a fourth competitor. Re-stated here with
-- the role check; the body is otherwise unchanged from
-- 20261119000400_fix_competition_transition_casts.sql.
-- ---------------------------------------------------------------------------
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

  if cardinality(p_model_ids) > 3 then
    raise exception 'at most three participating models are allowed'
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

  -- `role = 'competitor'` is the F31 distinction: the judge is active, but it
  -- is not part of the lineup that renders for the crowd.
  if (
    select count(*)
      from public.llm_models
     where id = any(p_model_ids)
       and is_active
       and role = 'competitor'
  ) <> cardinality(p_model_ids) then
    raise exception 'all participating models must be active competitors'
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
    'OPEN'::public.round_status,
    'CREATED'::public.round_status,
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
