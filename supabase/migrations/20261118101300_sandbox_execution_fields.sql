-- F13: fields the Docker sandbox runner needs.
--
-- The runner calls a single named function per challenge rather than running a
-- whole program, so a challenge must declare that entry point. `test_cases.input`
-- and `expected_output` carry JSON text (a positional-args array and a JSON
-- value) by convention — not by constraint, because the F12 seed bank already
-- holds non-JSON fixtures and this migration must apply cleanly to a live
-- project.
--
-- Written idempotently on purpose. The hosted project already carried
-- `challenges.entry_point` without a corresponding migration record (the schema
-- had drifted from migration history), so a plain ADD COLUMN aborted the push
-- with SQLSTATE 42701. Each step below is guarded so this file converges the
-- schema whether or not part of it was already applied by hand.

-- Nullable so pre-F13 rows stay valid; a *published* challenge must be runnable
-- (constraint below), a draft may still be incomplete.
do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'challenges'
      and column_name = 'entry_point'
  ) then
    alter table public.challenges add column entry_point text;
  end if;
end
$$;

-- The format check rejects a leading underscore on purpose: no legitimate entry
-- point starts with `_`, and it blocks `__import__` / `__dict__`-flavoured
-- attribute poking at the call site. The harness still validates independently —
-- this is defence in depth, not the control.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'challenges_entry_point_format'
      and conrelid = 'public.challenges'::regclass
  ) then
    alter table public.challenges
      add constraint challenges_entry_point_format check (
        entry_point is null or entry_point ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
      );
  end if;
end
$$;

-- Publishing is the point where incompleteness becomes a runtime failure, so
-- gate it here, matching ensure_round_challenge_published()'s existing pattern
-- for incomplete challenges. F12's seed must set entry_point before flipping
-- status to 'published' or this update will fail.
--
-- NOT VALID on purpose: ADD CONSTRAINT otherwise scans and validates every
-- existing row, so a single already-published challenge without an entry point
-- would abort the whole migration on a live project. NOT VALID applies the rule
-- to every new insert/update and leaves existing rows for F12's backfill.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'challenges_published_has_entry_point'
      and conrelid = 'public.challenges'::regclass
  ) then
    alter table public.challenges
      add constraint challenges_published_has_entry_point check (
        status <> 'published' or entry_point is not null
      ) not valid;
  end if;
end
$$;

comment on column public.challenges.entry_point is
  'Python function the sandbox calls: <entry_point>(*json.loads(test_cases.input)). NULL for drafts.';

-- Reproducibility (NFR: same solution + same challenge → same verdict). A
-- verdict can change if the sandbox image changes, so snapshot the exact image
-- at execution time — exactly as openrouter_model_id snapshots the model (F16).
-- harness_protocol lets the host tell which result-record contract an old row
-- was produced under.
do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'model_executions'
      and column_name = 'sandbox_image'
  ) then
    alter table public.model_executions add column sandbox_image text;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'model_executions'
      and column_name = 'harness_protocol'
  ) then
    alter table public.model_executions add column harness_protocol integer;
  end if;
end
$$;