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
-- the demo less reliable rather than cheaper.
--
-- WHY THESE THREE, AND NOT SMALLER CHEAPER MODELS: `mistral-nemo`,
-- `command-r7b` and `llama-3.1-8b` are an order of magnitude cheaper and do
-- render — every one of them passes the deterministic gate. Judged against the
-- brief, though, none produced a recognisable donut: they draw *something*
-- that moves, not the thing that was asked for. A round where every model is
-- not-conformed is not a showdown. These three were verified against the same
-- brief and the same chunk cap, and two of the three conform.
--
-- A round costs roughly a cent: three generations of a few thousand tokens plus
-- three vision judgements, all on models priced well under $1/M tokens.
--
-- The judge is deliberately NOT one of the competitors. Judging your own render
-- is a conflict of interest, and it also makes a swap a single row edit rather
-- than a scramble to re-seat both roles.
--
-- Re-running is safe: `on conflict (slug)` updates the row, and the slug is the
-- app-level identity — moving a competitor to a different OpenRouter model
-- updates that row rather than colliding on the slug's unique constraint.
--
-- WHAT THIS FILE DOES NOT DO: it does not seat a judge as a competitor. The
-- judge row carries `role = 'judge'` (F31, migration 20261119000700), and
-- `getActiveLineup()` selects `role = 'competitor'` only — so activating the
-- judge below is safe and the judge can never be drawn into the lineup.

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
    'gemini',
    'Gemini 2.5 Flash',
    'openrouter',
    'google/gemini-2.5-flash',
    '{"temperature": 0, "max_tokens": 4096}'::jsonb,
    true,
    1
  ),
  (
    'gpt-mini',
    'GPT-4o mini',
    'openrouter',
    'openai/gpt-4o-mini',
    '{"temperature": 0, "max_tokens": 4096}'::jsonb,
    true,
    2
  ),
  (
    'deepseek',
    'DeepSeek Chat v3.1',
    'openrouter',
    'deepseek/deepseek-chat-v3.1',
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
-- Retire every lineup this file previously seated.
--
-- `flash`, `north`, `flint` were free-tier reasoning models that spend the whole
-- chunk budget thinking and return `content: null` — they cannot render at all.
-- `nemo`, `command`, `llama` do render, but at 8B they draw something that only
-- passes the deterministic gate: judged against the brief, none produced a
-- recognisable donut. Deactivated rather than deleted so the executions already
-- recorded against them keep their foreign key and remain auditable.
-- ---------------------------------------------------------------------------
update public.llm_models
  set is_active = false
  where slug in ('flash', 'north', 'flint', 'nemo', 'command', 'llama');

-- ---------------------------------------------------------------------------
-- 2. The judge.
--
-- A vision-capable model that reads frames and rules on the rubric. Active, but
-- with `role = 'judge'`, so it is never handed the brief as a competitor:
-- `getActiveLineup()` filters on role, and `create_competition` refuses a
-- non-competitor. This is the whole switch — the pipeline resolves the judge by
-- role, so swapping models is a row edit, never a code change.
-- ---------------------------------------------------------------------------
insert into public.llm_models
  (slug, name, provider, openrouter_model_id, config, is_active, sort_order, role)
values
  (
    'judge',
    'Claude Haiku 4.5',
    'openrouter',
    'anthropic/claude-haiku-4.5',
    '{"temperature": 0, "max_tokens": 4096}'::jsonb,
    true,
    100,
    'judge'
  )
on conflict (slug) do update set
  name = excluded.name,
  provider = excluded.provider,
  openrouter_model_id = excluded.openrouter_model_id,
  config = excluded.config,
  -- F31 owns activation; re-running this seed seats the judge.
  is_active = excluded.is_active,
  sort_order = excluded.sort_order,
  role = excluded.role;

comment on table public.llm_models is
  'F16 lineup: every is_active row with role = ''competitor'' competes, ordered by sort_order. The role = ''judge'' row rules on renders (F31) and never competes.';
