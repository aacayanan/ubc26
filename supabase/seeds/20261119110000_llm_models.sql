-- F33/F16: the competitor lineup.
--
-- Re-scoped 2026-11-19 with the visual-showdown pivot. The lineup is
-- configuration, not code: `getActiveLineup()` selects every `is_active` row
-- ordered by `sort_order`, so this file is the whole definition of who competes.
--
-- Chosen 2026-11-19 by rendering each model's real output in the F14 sandbox,
-- not by reading a pricing table. Every competitor here was measured end to end:
-- three models × (a real brief → a real `drawFrame` → six real frames).
--
-- WHY PAID, NOT FREE: all 14 OpenRouter `:free` models were tried and none is
-- usable. They either error, or — being reasoning models — spend the whole
-- token budget thinking and return `content: null`, or (flint) run 30–76 s and
-- often return nothing at all. A competitor that cannot emit a render forfeits,
-- and a round where every model forfeits is voided (F15), so a free slot makes
-- the demo less reliable rather than cheaper. At these prices a round costs
-- well under a cent: 3 × (~300 in + ~350 out) ≈ $0.00005–$0.00007.
--
-- Re-running is safe: `on conflict (slug)` updates the row, and the slug is the
-- app-level identity — moving a competitor to a different OpenRouter model
-- updates that row rather than colliding on the slug's unique constraint.
--
-- WHAT THIS FILE DOES NOT DO: it does not activate the judge. `llm_models` has
-- no `role` column yet (F31 adds it) and `getActiveLineup()` returns every
-- active row, so an active judge would silently compete as a fourth model. The
-- judge row is seeded `is_active = false` for exactly that reason.

-- ---------------------------------------------------------------------------
-- 1. The competitors.
--
-- `config` sets temperature 0 so the same brief tends to the same render, and a
-- `max_tokens` that bounds the answer. `withTokenFloor()` in prompt.ts applies
-- the same floor in code, so a row that forgets its config is still bounded;
-- a value here is authoritative when present.
-- ---------------------------------------------------------------------------
insert into public.llm_models
  (slug, name, provider, openrouter_model_id, config, is_active, sort_order)
values
  (
    'nemo',
    'Mistral Nemo',
    'openrouter',
    'mistralai/mistral-nemo',
    '{"temperature": 0, "max_tokens": 4096}'::jsonb,
    true,
    1
  ),
  (
    'command',
    'Cohere Command R7B',
    'openrouter',
    'cohere/command-r7b-12-2024',
    '{"temperature": 0, "max_tokens": 4096}'::jsonb,
    true,
    2
  ),
  (
    'llama',
    'Llama 3.1 8B Instruct',
    'openrouter',
    'meta-llama/llama-3.1-8b-instruct',
    '{"temperature": 0, "max_tokens": 4096}'::jsonb,
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
-- Retire the free lineup this file previously seated.
--
-- The three :free rows (`flash`, `north`, `flint`) were measured and do not
-- render — see the header. Deactivated rather than deleted so the executions
-- already recorded against them keep their foreign key and remain auditable.
-- ---------------------------------------------------------------------------
update public.llm_models
  set is_active = false
  where slug in ('flash', 'north', 'flint');

-- ---------------------------------------------------------------------------
-- 2. The judge — seeded inactive until F31 can tell it apart from a competitor.
--
-- A vision-capable model that reads frames and rules on the rubric. Inactive
-- because `getActiveLineup()` has no role filter: an active row here would be
-- handed the brief as a competitor. F31 adds `role` and activates this row.
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
