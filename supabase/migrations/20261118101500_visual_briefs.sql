-- F12: the visual brief bank.
--
-- Re-scoped 2026-11-19: a competition is now one creative brief rendered by
-- each model, not a Python test-case challenge. The physical table stays
-- `challenges` because `rounds.challenge_id` pins a specific row and the issue
-- keeps that name; a brief IS a challenge row with `language = 'javascript'`.
-- Python rows from the pre-pivot bank keep working unchanged, so F13's runner
-- is not disturbed.
--
-- A brief carries everything needed to render it and to rule on conformance:
--   prompt            the brief text shown to every model
--   style_constraints the non-negotiable look, so a judge does not guess
--   entry_point       the global the renderer calls: <entry_point>(t, ctx, canvas)
--   target_duration_ms / frame_count / frame_width / frame_height
--   deterministic_checks  the gate definitions F14 executes
--   judge_rubric          the criteria F31 passes to the judge model
--   starter_code      optional scaffolding
--   reference_impl    a known-good implementation used to validate the brief
--
-- Publishing is the gate: a javascript brief cannot become `published` until it
-- is complete AND its reference implementation has actually rendered. The
-- validation script stamps `reference_validated_at` only after a real render,
-- so the timestamp is the proof, not a promise.
--
-- Written idempotently, matching the F13 migration: the hosted project has
-- drifted from migration history before, and a plain ADD COLUMN aborts a push.

-- ---------------------------------------------------------------------------
-- 1. Allow a javascript brief alongside python challenges.
--
-- The original column check was `language = 'python'`, auto-named. Drop any
-- check constraint that mentions `language` (whatever its name) rather than
-- assuming one, then add a named replacement.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.challenges'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%language%'
  loop
    execute format('alter table public.challenges drop constraint %I', c.conname);
  end loop;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'challenges_language_allowed'
      and conrelid = 'public.challenges'::regclass
  ) then
    alter table public.challenges
      add constraint challenges_language_allowed
      check (language in ('python', 'javascript'));
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Brief columns.
--
-- Nullable on purpose: a draft may be incomplete, and every pre-pivot python
-- row must stay valid. The publish trigger below is what requires them.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges'
      and column_name = 'style_constraints') then
    alter table public.challenges add column style_constraints text;
  end if;

  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges'
      and column_name = 'target_duration_ms') then
    alter table public.challenges add column target_duration_ms integer;
  end if;

  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges'
      and column_name = 'frame_count') then
    alter table public.challenges add column frame_count integer;
  end if;

  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges'
      and column_name = 'frame_width') then
    alter table public.challenges add column frame_width integer;
  end if;

  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges'
      and column_name = 'frame_height') then
    alter table public.challenges add column frame_height integer;
  end if;

  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges'
      and column_name = 'deterministic_checks') then
    alter table public.challenges add column deterministic_checks jsonb;
  end if;

  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges'
      and column_name = 'judge_rubric') then
    alter table public.challenges add column judge_rubric jsonb;
  end if;

  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges'
      and column_name = 'reference_impl') then
    alter table public.challenges add column reference_impl text;
  end if;

  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges'
      and column_name = 'reference_validated_at') then
    alter table public.challenges add column reference_validated_at timestamptz;
  end if;

  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges'
      and column_name = 'reference_image_digest') then
    alter table public.challenges add column reference_image_digest text;
  end if;

  -- Content fingerprint for repeatable, versioned seeding: an unchanged
  -- re-seed is a no-op, a changed one inserts version + 1.
  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges'
      and column_name = 'content_hash') then
    alter table public.challenges add column content_hash text;
  end if;
end
$$;

-- Numeric brief fields must be positive when present (a draft may leave them
-- null; the publish trigger requires them).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'challenges_brief_dimensions_positive'
      and conrelid = 'public.challenges'::regclass
  ) then
    alter table public.challenges
      add constraint challenges_brief_dimensions_positive check (
        (target_duration_ms is null or target_duration_ms > 0)
        and (frame_count is null or frame_count > 0)
        and (frame_width is null or frame_width > 0)
        and (frame_height is null or frame_height > 0)
      ) not valid;
  end if;
end
$$;

-- The check kinds a complete brief must define. Kept as a function so the SQL
-- gate and the SQL tests agree on one list.
create or replace function public.required_brief_check_kinds()
returns text[]
language sql
immutable
as $$
  select array[
    'process_exit',
    'no_uncaught_error',
    'frames_emitted',
    'frame_dimensions',
    'non_blank'
  ];
$$;

-- True when `checks` is a JSON array that defines every required kind at least
-- once. Extra kinds are allowed; a missing one means the brief is incomplete.
create or replace function public.brief_checks_complete(checks jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when jsonb_typeof(checks) is distinct from 'array' then false
    else (
      select count(distinct element->>'kind') = cardinality(public.required_brief_check_kinds())
      from jsonb_array_elements(checks) as element
      where element->>'kind' = any(public.required_brief_check_kinds())
    )
  end;
$$;

-- True when `rubric` is a non-empty array and every criterion carries an id, a
-- question and a numeric weight. A judge cannot rule on a criterion with no
-- question.
create or replace function public.brief_rubric_complete(rubric jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when jsonb_typeof(rubric) is distinct from 'array' then false
    when jsonb_array_length(rubric) = 0 then false
    else (
      select bool_and(
        element ? 'id'
        and element ? 'question'
        and element ? 'weight'
        and jsonb_typeof(element->'weight') = 'number'
        and length(trim(coalesce(element->>'question', ''))) > 0
      )
      from jsonb_array_elements(rubric) as element
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Publishing gate.
--
-- Only javascript briefs are gated; python rows keep the pre-pivot rules. The
-- raise messages are the operator's to-do list, so each names the exact gap.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_publishable_brief()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'published' and new.language = 'javascript' then
    if new.entry_point is null or new.entry_point !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$' then
      raise exception 'brief % has no valid entry point', new.slug
        using errcode = '23514';
    end if;
    if coalesce(trim(new.prompt), '') = '' then
      raise exception 'brief % has no brief text', new.slug
        using errcode = '23514';
    end if;
    if coalesce(trim(new.style_constraints), '') = '' then
      raise exception 'brief % has no style constraints', new.slug
        using errcode = '23514';
    end if;
    if new.target_duration_ms is null or new.target_duration_ms <= 0 then
      raise exception 'brief % has no target render duration', new.slug
        using errcode = '23514';
    end if;
    if new.frame_count is null or new.frame_count <= 0 then
      raise exception 'brief % has no frame count', new.slug
        using errcode = '23514';
    end if;
    if new.frame_width is null or new.frame_width <= 0
      or new.frame_height is null or new.frame_height <= 0 then
      raise exception 'brief % has no frame dimensions', new.slug
        using errcode = '23514';
    end if;
    if coalesce(trim(new.reference_impl), '') = '' then
      raise exception 'brief % has no reference implementation', new.slug
        using errcode = '23514';
    end if;
    if not public.brief_checks_complete(new.deterministic_checks) then
      raise exception 'brief % must define the deterministic checks %',
        new.slug, public.required_brief_check_kinds()
        using errcode = '23514';
    end if;
    if not public.brief_rubric_complete(new.judge_rubric) then
      raise exception 'brief % has an incomplete judge rubric', new.slug
        using errcode = '23514';
    end if;
    -- The proof that the reference implementation renders. Set by
    -- publish_brief() only after the validation script ran a real render.
    if new.reference_validated_at is null then
      raise exception 'brief % has not been validated by a reference render', new.slug
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists challenges_enforce_publishable_brief on public.challenges;
create trigger challenges_enforce_publishable_brief
  before insert or update on public.challenges
  for each row execute function public.enforce_publishable_brief();

-- ---------------------------------------------------------------------------
-- 4. Repeatable, versioned seeding.
--
-- seed_brief(doc) fingerprints the document and:
--   * inserts version 1 as a draft when the slug is new,
--   * returns 'unchanged' when the latest version has the same fingerprint,
--   * otherwise inserts the next version as a draft.
-- It never publishes: publishing requires a real render (publish_brief), which
-- is what keeps "a reference implementation renders before publishing" true.
-- ---------------------------------------------------------------------------
create or replace function public.seed_brief(doc jsonb)
returns table (slug text, version integer, action text)
language plpgsql
as $$
declare
  v_slug text := nullif(trim(doc->>'slug'), '');
  v_hash text := encode(digest(doc::text, 'sha256'), 'hex');
  v_latest_version integer;
  v_latest_hash text;
  v_next integer;
begin
  if v_slug is null then
    raise exception 'seed_brief: doc has no slug' using errcode = '22023';
  end if;

  select c.version, c.content_hash
    into v_latest_version, v_latest_hash
    from public.challenges c
    where c.slug = v_slug
    order by c.version desc
    limit 1;

  if v_latest_version is not null and v_latest_hash = v_hash then
    return query select v_slug, v_latest_version, 'unchanged'::text;
    return;
  end if;

  v_next := coalesce(v_latest_version, 0) + 1;

  insert into public.challenges (
    slug, version, title, prompt, starter_code, language, status,
    entry_point, style_constraints, target_duration_ms, frame_count,
    frame_width, frame_height, deterministic_checks, judge_rubric,
    reference_impl, content_hash
  ) values (
    v_slug,
    v_next,
    coalesce(doc->>'title', v_slug),
    coalesce(doc->>'prompt', ''),
    coalesce(doc->>'starter_code', ''),
    coalesce(doc->>'language', 'javascript'),
    'draft',
    doc->>'entry_point',
    doc->>'style_constraints',
    nullif(doc->>'target_duration_ms', '')::integer,
    nullif(doc->>'frame_count', '')::integer,
    nullif(doc->>'frame_width', '')::integer,
    nullif(doc->>'frame_height', '')::integer,
    doc->'deterministic_checks',
    doc->'judge_rubric',
    doc->>'reference_impl',
    v_hash
  );

  return query select v_slug, v_next, 'inserted'::text;
end;
$$;

-- Publish a draft that has passed a real render. The caller passes the sandbox
-- image digest that produced the frames, so a later change to the renderer is
-- visible in the row. The publish trigger re-checks completeness.
create or replace function public.publish_brief(
  p_slug text,
  p_version integer,
  p_image_digest text default null
)
returns void
language plpgsql
as $$
begin
  update public.challenges
    set status = 'published',
        reference_validated_at = now(),
        reference_image_digest = p_image_digest
    where slug = p_slug
      and version = p_version
      and status = 'draft';

  if not found then
    raise exception 'publish_brief: % v% is not a draft', p_slug, p_version
      using errcode = 'P0002';
  end if;
end;
$$;

-- Seeding and publishing are server-side jobs. Clients never call them.
revoke all on function public.seed_brief(jsonb) from public;
revoke all on function public.publish_brief(text, integer, text) from public;
grant execute on function public.seed_brief(jsonb) to postgres;
grant execute on function public.publish_brief(text, integer, text) to postgres;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.seed_brief(jsonb) to service_role';
    execute 'grant execute on function public.publish_brief(text, integer, text) to service_role';
  end if;
end
$$;

comment on column public.challenges.style_constraints is
  'Non-negotiable look of the render, shown to every model and to the judge (F12/F31).';
comment on column public.challenges.deterministic_checks is
  'Gate definitions F14 executes: process_exit, no_uncaught_error, frames_emitted, frame_dimensions, non_blank.';
comment on column public.challenges.judge_rubric is
  'Criteria F31 passes to the judge model: [{id, question, weight}].';
comment on column public.challenges.reference_impl is
  'Known-good implementation; rendered in the sandbox before the brief may publish.';
comment on column public.challenges.reference_validated_at is
  'Set by publish_brief() only after the reference implementation rendered successfully.';
comment on column public.challenges.content_hash is
  'Fingerprint of the seed document; an unchanged re-seed is a no-op, a changed one bumps version.';
