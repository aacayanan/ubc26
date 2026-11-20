-- F27: hold the two clocks on model_executions too.
--
-- The original policy was `using (true)` (20261118100800), written before the
-- pivot, when an execution row carried only a coding-test result. Post-pivot it
-- carries `error_message` — whatever OpenRouter said, including status lines and
-- provider diagnostics — and `solution_code`, the model's source.
--
-- That is exactly what the two-clocks rule forbids a viewer from reading before
-- the betting window closes, and the F17 tables already scope on it:
-- `generation_chunks`, `render_previews` and `judge_verdicts` each require
-- `rounds.status not in ('CREATED', 'OPEN')`. This makes the parent row agree
-- with them instead of being the one table that leaks.
--
-- Writes stay service-role-only (no write policy), matching the rest.
--
-- Note what this does and does not fix: the progress endpoint reads through the
-- service role and does its own gating, so this is the second line of defence,
-- not the first. It closes the direct anon-key read of a locked-but-unrevealed
-- round's provider errors.

drop policy if exists model_executions_public_read on public.model_executions;

create policy model_executions_public_read on public.model_executions
  for select using (
    exists (
      select 1
      from public.rounds r
      where r.id = model_executions.round_id
        and r.status not in ('CREATED', 'OPEN')
    )
  );

comment on policy model_executions_public_read on public.model_executions is
  'F27: an execution is readable only once its round is past OPEN. Mirrors the generation_chunks/render_previews/judge_verdicts policies so provider error text and model source cannot be read while staking is still open.';
