-- F14: rendered artifacts and their deterministic gate verdict.
--
-- A model writes code; the render sandbox draws it; the host decides whether the
-- result qualifies. This table is where that decision lands, and it is the thing
-- F19 replays and F31 judges from — so it stores the frames themselves, not a
-- pointer to them (F14 storage decision: Postgres, no bucket).
--
-- One row per model execution. The composite unique key turns a re-run into an
-- update, matching how F13/F16 make an interrupted evaluation safe to resume.
--
-- The gate columns are a *qualification* record, not a score: F15 decides what a
-- failure costs, and F14 only reports what each check saw. A forfeit never
-- quietly becomes "last place with points" (REQUIREMENTS.md non-negotiable #9).
--
-- Written idempotently, matching 20261118101300/20261118101500: the hosted
-- project has drifted from migration history before.

create table if not exists public.rendered_artifacts (
  id uuid primary key default gen_random_uuid(),
  -- The generation execution whose code produced these frames.
  execution_id uuid not null
    references public.model_executions (id) on delete cascade,
  -- Aggregate qualification verdict (conjunction of `checks`). F15 maps this to
  -- a result status; F17 uses it as the gate before invoking the judge.
  gate_passed boolean not null,
  -- First failing check's plain-language reason, or null when the gate passed.
  -- Safe to show a user (F19); never contains frame bytes or model output.
  gate_failure_reason text,
  -- Per-check outcomes: [{kind, passed, reason, observed}] (F14 acceptance).
  checks jsonb not null default '[]'::jsonb,
  -- What the render actually did, kept as observations so a disputed verdict can
  -- be re-read without re-rendering (F31: "re-run judging on stored frames").
  frame_count integer not null default 0,
  frame_width integer,
  frame_height integer,
  exit_code integer,
  page_error text,
  render_error text,
  unavailable boolean not null default false,
  timed_out boolean not null default false,
  oom_killed boolean not null default false,
  wall_ms integer,
  -- Reproducibility (REQUIREMENTS.md non-negotiable #7): the exact digest-pinned
  -- image that produced these frames. Same code + same brief + same digest
  -- yields the same frames, so a verdict can be audited against it.
  image_digest text,
  harness_protocol integer,
  -- The frames: [{index, png(base64), blank, distinctColors, width, height}].
  -- Capped by the writer (see evaluation/artifacts.ts); frames_truncated says
  -- whether the stored set is the whole render.
  frames jsonb not null default '[]'::jsonb,
  frames_truncated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One artifact per execution: a re-run updates rather than duplicating.
  unique (execution_id)
);

create trigger rendered_artifacts_set_updated_at
  before update on public.rendered_artifacts
  for each row execute function public.set_updated_at();

-- Replay/result reads are per execution; the FK index serves the cascade too.
create index rendered_artifacts_execution_idx
  on public.rendered_artifacts (execution_id);

-- A passing gate cannot carry a failure reason, and both jsonb columns must be
-- arrays so a reader never has to defend against a scalar.
alter table public.rendered_artifacts
  add constraint rendered_artifacts_gate_consistent check (
    (gate_passed and gate_failure_reason is null)
    or (not gate_passed)
  );

alter table public.rendered_artifacts
  add constraint rendered_artifacts_frames_array check (
    jsonb_typeof(frames) = 'array'
  );

alter table public.rendered_artifacts
  add constraint rendered_artifacts_checks_array check (
    jsonb_typeof(checks) = 'array'
  );

-- ---------------------------------------------------------------------------
-- Row-level security.
--
-- Artifacts are public record, but not *before the betting window closes*: the
-- two-clocks rule says no render is visible until the round is LOCKED, and the
-- database is where that holds even if a route forgets to filter. Reads are
-- therefore scoped to the owning round's status. Writes are service-role-only,
-- exactly like model_executions and test_results.
-- ---------------------------------------------------------------------------
alter table public.rendered_artifacts enable row level security;

create policy rendered_artifacts_public_read on public.rendered_artifacts
  for select using (
    exists (
      select 1
      from public.model_executions e
      join public.rounds r on r.id = e.round_id
      where e.id = rendered_artifacts.execution_id
        and r.status not in ('CREATED', 'OPEN')
    )
  );

comment on table public.rendered_artifacts is
  'F14: frames one model execution rendered, plus per-check deterministic gate outcomes (the Rendered Artifacts entity in CLAUDE.md).';
comment on column public.rendered_artifacts.gate_passed is
  'Conjunction of checks. False means the model is ineligible for judging and for fan-favorite points (F14/F15).';
comment on column public.rendered_artifacts.checks is
  'Per-check outcomes [{kind, passed, reason, observed}]. Replayable without re-rendering.';
comment on column public.rendered_artifacts.image_digest is
  'Digest of the pinned render image; the reproducibility anchor for this verdict.';
