-- F25: historical model performance across settled rounds.
--
-- F25's question is "how has each competitor actually done?" — conformance rate
-- and crowd win rate over the rounds it took part in. Two things stop the
-- answer being a straight query over `competition_results`, and this migration
-- fixes both.
--
--   1. **Participation is not the same as a result row.** Settlement writes a
--      `competition_results` row only for rounds that reach it. A round that
--      ends FAILED/CANCELLED/VOIDED-before-settlement can leave a model with no
--      row at all, so a results-only read would *silently omit* it — exactly the
--      failure F25's acceptance criteria forbid ("failed/void rounds are labeled
--      rather than silently omitted"). The honest base is `round_models`: every
--      round a model was seated in, whether or not it produced an outcome.
--   2. **"Comparable" has a definition.** Only post-pivot rounds are
--      apples-to-apples: a round on a JavaScript brief, judged on conformance.
--      The retired Python challenge rounds and the retired accuracy/speed/
--      code-length categories are a different competition and are excluded
--      rather than averaged in.
--
-- The per-round fact each (model, round) pair needs is small and repeated, so a
-- view gives the app one readable shape and the indexes below make the read a
-- pair of index range scans rather than a scan of every prediction and verdict.
-- The view is the *rows*; the rate arithmetic stays in the pure, tested TS
-- aggregate (`services/models/analytics.ts`) so the rules are unit-testable the
-- same way F15's resolver and F24's rankings are.

-- ---------------------------------------------------------------------------
-- 1. Indexes for the reads behind the view.
--
-- `competition_results` is already indexed on (round_id) and (model_id)
-- separately (20261118100600); the analytics read filters by category too, so a
-- composite avoids re-checking a heap row per round.
-- ---------------------------------------------------------------------------
create index if not exists competition_results_model_category_idx
  on public.competition_results (model_id, category);

-- The view's join back into `competition_results` is by (round_id, model_id,
-- category); the existing round_idx covers the round side.
create index if not exists competition_results_round_model_category_idx
  on public.competition_results (round_id, model_id, category);

-- The crowd tally behind the fan-favorite pick is per round.
create index if not exists round_votes_round_model_idx
  on public.round_votes (round_id, model_id);

-- ---------------------------------------------------------------------------
-- 2. The per-(model, round) analytics fact.
--
-- One row per model that was seated in a comparable (post-pivot, JavaScript)
-- round that has reached a *terminal* state — SETTLED, VOIDED, ARCHIVED, FAILED
-- or CANCELLED. An undecided round (CREATED…EVALUATING, RETRYING) is not
-- history yet, so it is absent here rather than counted as a loss; a FAILED
-- round that is being retried leaves this history until it reaches a terminal
-- state again.
--
-- `outcome` distinguishes the three ways a comparable round ends for a model:
--   * 'settled'  — the round resolved; `conformance` says how it went
--   * 'voided'   — the round was void (all forfeited / no conformer)
--   * 'unsettled'— the round ended without a result (CANCELLED/FAILED):
--                  labeled, never dropped.
--
-- The outcome is read from `round_outcomes.kind` when a row exists, not from
-- the status: an ARCHIVED round can have been settled *or* voided, and reading
-- the status alone would report every archived void as a settle.
--
-- `security_invoker = true` so the view is read under the *caller's* RLS, not
-- the owner's. The underlying rows are all publicly readable once a round is
-- past OPEN (F27), and this view only ever includes decided rounds, so the
-- invoker rules and the view's filter agree rather than one masking the other.
-- ---------------------------------------------------------------------------
create or replace view public.model_round_analytics
with (security_invoker = true)
as
select
  rm.model_id,
  r.id                                            as round_id,
  r.slug                                          as round_slug,
  c.title                                         as brief_title,
  case
    when ro.kind = 'settled'                 then 'settled'
    when ro.kind = 'voided'                  then 'voided'
    when r.status in ('SETTLED', 'ARCHIVED') then 'settled'
    else                                          'unsettled'
  end                                             as outcome,
  -- The model's recorded conformance status, when settlement wrote one. NULL on
  -- a void, an unsettled round, or a model the round never evaluated.
  cr.status                                       as conformance,
  -- The crowd's pick and the conforming winner, so a conformance win rate and a
  -- crowd win rate are both answerable from one row.
  ro.winner_model_id                              as winner_model_id,
  ro.fan_favorite_model_id                        as fan_favorite_model_id,
  -- The round's honest decision moment (a void has no settled_at). Mirrors
  -- `results.ts`'s settledMoment so the two orderings cannot disagree.
  coalesce(r.settled_at, ro.created_at, r.updated_at) as decided_at
from public.round_models rm
join public.rounds r on r.id = rm.round_id
join public.challenges c on c.id = r.challenge_id
left join public.competition_results cr
  on cr.round_id = r.id
 and cr.model_id = rm.model_id
 and cr.category = 'conformance'
left join public.round_outcomes ro on ro.round_id = r.id
-- Terminal states only. FAILED and CANCELLED are here on purpose: a round that
-- ended without a result must still appear for every model that was seated in
-- it, which is the whole point of F25's "labeled, not omitted" criterion.
where r.status in ('SETTLED', 'VOIDED', 'ARCHIVED', 'FAILED', 'CANCELLED')
  -- Comparable: post-pivot briefs are JavaScript renderers. A retired Python
  -- challenge or a pre-pivot category is a different contest.
  and c.language = 'javascript';

comment on view public.model_round_analytics is
  'F25: one row per model per comparable, terminal round (JavaScript brief; SETTLED/VOIDED/ARCHIVED/FAILED/CANCELLED). Drives conformance and crowd win rates. A round with no result row still appears with outcome unsettled, so a failure is labeled rather than silently omitted.';

-- ---------------------------------------------------------------------------
-- 3. The non-settled comparable rounds, listed.
--
-- The view above already exposes failed/void rounds per model, but the page
-- also names them once in a "history gaps" list, so a reader can see the rounds
-- that were left out of the win/loss arithmetic and why. Kept as its own view
-- so the page does not have to de-duplicate `model_round_analytics` to recover
-- the round-level list.
-- ---------------------------------------------------------------------------
create or replace view public.round_history_gaps
with (security_invoker = true)
as
select
  r.id      as round_id,
  r.slug    as round_slug,
  c.title   as brief_title,
  r.status,
  case
    when ro.kind = 'voided' or r.status = 'VOIDED' then 'voided'
    else 'unsettled'
  end       as outcome,
  ro.reason as reason,
  coalesce(r.settled_at, ro.created_at, r.updated_at) as decided_at
from public.rounds r
join public.challenges c on c.id = r.challenge_id
left join public.round_outcomes ro on ro.round_id = r.id
where c.language = 'javascript'
  -- Only terminal rounds are history. FAILED/CANCELLED/RETRYING are not, but
  -- every terminal status is: a resolved round is settled-or-void, and anything
  -- else terminal (FAILED, CANCELLED, an archived void) is a gap.
  and r.status in ('SETTLED', 'VOIDED', 'ARCHIVED', 'FAILED', 'CANCELLED')
  -- A round that resolved is history, not a gap. `is distinct from` rather than
  -- `<>` because a FAILED round has no outcome row and NULL = 'settled' is NULL,
  -- which would filter the very rows this view exists to surface.
  and coalesce(ro.kind, case when r.status in ('SETTLED', 'ARCHIVED') then 'settled' end)
      is distinct from 'settled';

comment on view public.round_history_gaps is
  'F25: comparable rounds that did not produce a settled result (void, failed, cancelled). Surfaced so the analytics page labels them instead of silently leaving them out of every model''s totals.';
