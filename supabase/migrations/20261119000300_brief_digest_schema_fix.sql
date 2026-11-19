-- F12 fix: make seed_brief() resolve pgcrypto regardless of where it lives.
--
-- `seed_brief()` computed its content fingerprint with a bare
--     encode(digest(doc::text, 'sha256'), 'hex')
-- which only resolves when pgcrypto is on the caller's search_path. Supabase
-- installs extensions into the `extensions` schema, so on the hosted project
-- the seed failed with:
--
--     ERROR: function digest(text, unknown) does not exist (SQLSTATE 42883)
--
-- 20261118100000_init.sql's `create extension if not exists pgcrypto` was a
-- no-op there — the extension already existed, in a schema the function did
-- not look at. Every local run passed because pgcrypto's default install
-- target is `public`, which the search_path does include. That is exactly the
-- kind of drift that only shows up on the hosted project.
--
-- Rather than hardcode `extensions.` (which would break the local stack the
-- other way round), the digest is wrapped in a helper that is built against
-- whatever schema pgcrypto actually landed in, discovered from the catalog.

-- ---------------------------------------------------------------------------
-- 1. A stable digest helper.
--
-- Rebuilt from the catalog rather than declared inline so it is correct
-- wherever pgcrypto lives. `immutable` matches digest() so it can be used in
-- the same contexts.
-- ---------------------------------------------------------------------------
do $$
declare
  v_extension_schema text;
begin
  select n.nspname
    into v_extension_schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto';

  if v_extension_schema is null then
    -- Nothing to wrap. Fail loudly rather than leave a helper that would
    -- silently mis-hash later: a missing pgcrypto means seeding cannot work.
    raise exception
      'pgcrypto is not installed; seed_brief requires digest() for its content fingerprint'
      using errcode = '42704';
  end if;

  -- Format %I quoting means a hostile schema name cannot inject SQL here, and
  -- it keeps the generated function readable in \df.
  execute format(
    $fn$
      create or replace function public.brief_content_digest(p_text text)
      returns text
      language sql
      immutable
      set search_path = ''
      as $body$
        select encode(%I.digest(p_text, 'sha256'), 'hex')
      $body$
    $fn$,
    v_extension_schema
  );

  execute format(
    'comment on function public.brief_content_digest(text) is %L',
    'sha256 fingerprint of a brief seed document; wraps pgcrypto digest() from the ' ||
    v_extension_schema || ' schema (F12).'
  );
end
$$;

revoke all on function public.brief_content_digest(text) from public;
grant execute on function public.brief_content_digest(text) to postgres;

do $$
begin
  -- Seeding is a server-side job; the service role runs it.
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.brief_content_digest(text) to service_role';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Recreate seed_brief() against the helper.
--
-- Identical to 20261118101500's definition in every respect except the single
-- digest call. Recreated whole rather than patched because the function body is
-- one literal; a targeted edit is not expressible in SQL.
-- ---------------------------------------------------------------------------
create or replace function public.seed_brief(doc jsonb)
returns table (slug text, version integer, action text)
language plpgsql
as $$
declare
  v_slug text := nullif(trim(doc->>'slug'), '');
  v_hash text := public.brief_content_digest(doc::text);
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

revoke all on function public.seed_brief(jsonb) from public;
grant execute on function public.seed_brief(jsonb) to postgres;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.seed_brief(jsonb) to service_role';
  end if;
end
$$;

comment on function public.seed_brief(jsonb) is
  'Insert-or-bump a versioned brief seed; unchanged documents are a no-op (F12). Fingerprints via public.brief_content_digest().';
