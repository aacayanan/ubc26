-- The tiered lineup (2026-11-20). Extends 20261119110000_llm_models.sql.
--
-- The four rungs and their buy-ins are the ladder in
-- 20261120000900_model_tiers.sql. This file seats models on each rung. The same
-- two constraints as the original lineup apply, and both are why the picks are
-- conservative:
--
--   * **A model has to render.** The competitor writes a `drawFrame` renderer;
--     a model that cannot emit one forfeits every round it enters.
--   * **A model has to follow the brief.** Cheaper-than-cheap models pass the
--     deterministic gate and still draw the wrong thing; the original seed
--     retired three of them for exactly that.
--
-- So the rungs reuse the three models that were measured end to end rather than
-- crowning an unverified model on price alone, and each new rung adds a model
-- whose ID was checked against the live catalog on 2026-11-20.
--
-- `config` deliberately omits `temperature` on models whose catalog entry does
-- NOT advertise it in `supported_parameters` (the GPT-5.5 and Claude 5.5 families
-- below reject an explicit temperature with a 400); a model that cannot be
-- pinned to temperature 0 is still bounded by `max_tokens`. Re-running is safe:
-- `on conflict (slug)` updates the row.

-- ---------------------------------------------------------------------------
-- 1. Seat the rungs on the models already in the catalog.
-- ---------------------------------------------------------------------------
update public.llm_models set tier = 'cheap'
  where slug in ('gemini', 'gpt-mini', 'deepseek');

-- ---------------------------------------------------------------------------
-- 2. New models, by rung.
--
-- Tier follows price rather than marketing: "mid" is a model costing several
-- times a cheap one but well under the frontier names, and "frontier" /
-- "exclusive" are the highest-output-cost entries. The buy-in that prices a
-- rung lives in model_tiers, not here.
-- ---------------------------------------------------------------------------
insert into public.llm_models
  (slug, name, provider, openrouter_model_id, config, is_active, sort_order, role, tier)
values
  -- Mid rung.
  (
    'kimi',
    'Kimi K2.5',
    'openrouter',
    'moonshotai/kimi-k2.5',
    '{"temperature": 0, "max_tokens": 4096}'::jsonb,
    true,
    10,
    'competitor',
    'mid'
  ),
  (
    'gemini-flash-3',
    'Gemini 3 Flash',
    'openrouter',
    'google/gemini-3-flash-preview',
    '{"temperature": 0, "max_tokens": 4096}'::jsonb,
    true,
    11,
    'competitor',
    'mid'
  ),
  (
    'deepseek-v4-flash',
    'DeepSeek V4.1 Flash',
    'openrouter',
    'deepseek/deepseek-v4.1-flash',
    '{"temperature": 0, "max_tokens": 4096}'::jsonb,
    true,
    12,
    'competitor',
    'mid'
  ),

  -- Frontier rung.
  (
    'claude-sonnet',
    'Claude Sonnet 5.5',
    'openrouter',
    'anthropic/claude-sonnet-5.5',
    -- No temperature: not in this model's supported_parameters.
    '{"max_tokens": 4096}'::jsonb,
    true,
    20,
    'competitor',
    'frontier'
  ),
  (
    'gpt-55',
    'GPT-5.5',
    'openrouter',
    'openai/gpt-5.5',
    '{"max_tokens": 4096}'::jsonb,
    true,
    21,
    'competitor',
    'frontier'
  ),
  (
    'gemini-pro-3',
    'Gemini 3.1 Pro',
    'openrouter',
    'google/gemini-3.1-pro-preview',
    '{"temperature": 0, "max_tokens": 4096}'::jsonb,
    true,
    22,
    'competitor',
    'frontier'
  ),

  -- Exclusive rung.
  (
    'claude-opus',
    'Claude Opus 5.5',
    'openrouter',
    'anthropic/claude-opus-5.5',
    '{"max_tokens": 4096}'::jsonb,
    true,
    30,
    'competitor',
    'exclusive'
  ),
  (
    'claude-fable',
    'Claude Fable 5.1',
    'openrouter',
    'anthropic/claude-fable-5.1',
    '{"max_tokens": 4096}'::jsonb,
    true,
    31,
    'competitor',
    'exclusive'
  ),
  (
    'gpt-55-pro',
    'GPT-5.5 Pro',
    'openrouter',
    'openai/gpt-5.5-pro',
    '{"max_tokens": 4096}'::jsonb,
    true,
    32,
    'competitor',
    'exclusive'
  )
on conflict (slug) do update set
  name = excluded.name,
  provider = excluded.provider,
  openrouter_model_id = excluded.openrouter_model_id,
  config = excluded.config,
  is_active = excluded.is_active,
  sort_order = excluded.sort_order,
  role = excluded.role,
  tier = excluded.tier;

-- The judge is not on the ladder. Keep it unseated so create_sol_competition
-- can never price it.
update public.llm_models set tier = null where role = 'judge';

-- The `demo/*` rows are placeholders the F8 migration inserted so a fresh
-- database had something to open a round against; their OpenRouter IDs are not
-- real and generation fails against them. The original lineup seed already
-- filters them out of scripts. Retire them here so the admin model picker shows
-- only real, priced competitors. Deactivated, not deleted, so any execution
-- already recorded against them keeps its foreign key.
update public.llm_models set is_active = false where openrouter_model_id like 'demo/%';
