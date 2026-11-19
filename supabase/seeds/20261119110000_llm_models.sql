-- F33/F16: the competitor lineup, on free OpenRouter models.
--
-- Re-scoped 2026-11-19 with the visual-showdown pivot. The lineup is
-- configuration, not code: `getActiveLineup()` selects every `is_active` row
-- ordered by `sort_order`, so this file is the whole definition of who competes.
--
-- Every model here is an OpenRouter `:free` model, so a demo costs nothing and
-- the $10 key budget is never touched. Chosen and verified 2026-11-19 by
-- calling each one through the real API with the F33 prompt: all returned a
-- `drawFrame(t, ctx, canvas)` function.
--
-- Re-running is safe. `on conflict (openrouter_model_id)` updates the row, so a
-- price or config change is one edit away. Slugs are the app-level identity and
-- are unique independently.
--
-- WHAT THIS FILE DOES NOT DO: it does not seed the judge. `llm_models` has no
-- `role` column yet (F31 adds it), and `getActiveLineup()` returns every active
-- row — so an active judge row would silently compete as a fourth model. The
-- judge row below is seeded `is_active = false` for exactly that reason, and
-- F31 flips it on when it can distinguish `role = 'judge'`.

-- ---------------------------------------------------------------------------
-- 1. The competitors — three models, identical prompt and config.
--
-- `config` is the per-model generation params snapshot. It is NOT identical
-- across models on purpose: these are all reasoning-capable, and a small
-- `max_tokens` makes them spend the whole budget thinking and return
-- `content: null` with `finish_reason: "length"` — a malformed response the
-- client correctly rejects. The cap is set high enough that reasoning finishes
-- and content is emitted. Temperature is 0 so the same brief tends to the same
-- render, which keeps the demo reproducible.
--
-- LATENCY: measured 6–8 s per call on an idle free tier, but a free model is
-- queued behind other users and a single request was observed timing out at
-- 90 s twice in a row. That is provider congestion, not a model fault, and the
-- F16 client retries it — but the demo budget is 2–3 minutes end to end, so
-- OPENROUTER_TIMEOUT_MS and OPENROUTER_MAX_ATTEMPTS should be revisited before
-- the recording. See REQUIREMENTS.md open item 2.
-- ---------------------------------------------------------------------------
insert into public.llm_models
  (slug, name, provider, openrouter_model_id, config, is_active, sort_order)
values
  (
    'flash',
    'ERNIE 5.5 Flash',
    'openrouter',
    'baidu/ernie-5.5-flash-preview:free',
    '{"temperature": 0, "max_tokens": 8192}'::jsonb,
    true,
    1
  ),
  (
    'north',
    'Cohere North Mini Code',
    'openrouter',
    'cohere/north-mini-code:free',
    '{"temperature": 0, "max_tokens": 8192}'::jsonb,
    true,
    2
  ),
  (
    'flint',
    'Recursive Flint',
    'openrouter',
    'recursive/flint-v1.0:free',
    '{"temperature": 0, "max_tokens": 8192}'::jsonb,
    true,
    3
  )
on conflict (slug) do update set
  name = excluded.name,
  provider = excluded.provider,
  openrouter_model_id = excluded.openrouter_model_id,
  config = excluded.config,
  is_active = excluded.is_active,
  sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- 2. The judge — seeded inactive until F31 can tell it apart from a competitor.
--
-- A vision-capable free model that reads frames and rules on the rubric. It is
-- `is_active = false` because `getActiveLineup()` has no role filter: an active
-- row here would be handed the brief as a competitor. F31 adds `role` and
-- activates this row.
-- ---------------------------------------------------------------------------
insert into public.llm_models
  (slug, name, provider, openrouter_model_id, config, is_active, sort_order)
values
  (
    'judge',
    'Nemotron 3.5 Super VL',
    'openrouter',
    'nvidia/nemotron-3.5-super-vl:free',
    '{"temperature": 0, "max_tokens": 4096}'::jsonb,
    false,
    100
  )
on conflict (slug) do update set
  name = excluded.name,
  provider = excluded.provider,
  openrouter_model_id = excluded.openrouter_model_id,
  config = excluded.config,
  -- Deliberately NOT re-activating: F31 owns that switch. Re-running this seed
  -- must never promote the judge into the competitor lineup.
  sort_order = excluded.sort_order;

comment on table public.llm_models is
  'F16 lineup: every is_active row competes, ordered by sort_order. The judge row is inactive until F31 adds role.';
