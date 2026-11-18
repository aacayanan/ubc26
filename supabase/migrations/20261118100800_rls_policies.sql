-- F2: row-level security for every table.
--
-- Rules (issue #2 acceptance criteria):
--   * RLS protects user-owned data (wallets, predictions, transactions).
--   * Public competition/results reads stay open (rounds, results, scores,
--     models, published challenges, public test cases).
--   * Hidden test cases and drafts are never client-readable.
--   * Writes are service-role-only (server-side) except: own profile/wallet
--     rows, and predictions — the one user-originated write, scoped by
--     auth.uid() at the database.
--   * service_role has BYPASSRLS (Supabase default) and needs no policies.
--
-- Policies are role-agnostic: one policy covers anon + authenticated, both
-- of which hold Supabase's default table grants. No policy for a role = deny.

alter table public.users enable row level security;
alter table public.wallets enable row level security;
alter table public.llm_models enable row level security;
alter table public.challenges enable row level security;
alter table public.test_cases enable row level security;
alter table public.rounds enable row level security;
alter table public.round_models enable row level security;
alter table public.predictions enable row level security;
alter table public.model_executions enable row level security;
alter table public.test_results enable row level security;
alter table public.competition_results enable row level security;
alter table public.score_events enable row level security;
alter table public.user_scores enable row level security;
alter table public.blockchain_transactions enable row level security;

-- ---------------------------------------------------------------------------
-- users: profiles are public (no email stored); writes restricted to the
-- owner AND to non-privileged columns (role must never be client-settable).
-- ---------------------------------------------------------------------------
create policy users_public_read on public.users
  for select using (true);

create policy users_insert_own on public.users
  for insert with check (id = auth.uid());

create policy users_update_own on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

revoke insert, update on public.users from anon, authenticated;
grant insert (id, display_name, avatar_url) on public.users to authenticated;
grant update (display_name, avatar_url) on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- wallets: user-owned data — owner-only read/write, never client-deletable.
-- verified_at is server-set after the ownership proof (F20).
-- ---------------------------------------------------------------------------
create policy wallets_select_own on public.wallets
  for select using (user_id = auth.uid());

create policy wallets_insert_own on public.wallets
  for insert with check (user_id = auth.uid());

create policy wallets_update_own on public.wallets
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke insert, update on public.wallets from anon, authenticated;
grant insert (user_id, address, chain, cluster) on public.wallets to authenticated;
grant update (address, chain, cluster) on public.wallets to authenticated;

-- ---------------------------------------------------------------------------
-- llm_models: public catalog; seeding is a service-role job (F12).
-- ---------------------------------------------------------------------------
create policy llm_models_public_read on public.llm_models
  for select using (true);

-- ---------------------------------------------------------------------------
-- challenges: clients only ever see published challenges (F12: invalid or
-- incomplete challenges cannot be selected — drafts stay invisible too).
-- ---------------------------------------------------------------------------
create policy challenges_public_read on public.challenges
  for select using (status = 'published');

-- ---------------------------------------------------------------------------
-- test_cases: public cases of published challenges only. Hidden cases are
-- server-only — this is the leak-prevention policy for F12/F13.
-- ---------------------------------------------------------------------------
create policy test_cases_public_read on public.test_cases
  for select using (
    kind = 'public'
    and exists (
      select 1 from public.challenges c
      where c.id = test_cases.challenge_id and c.status = 'published'
    )
  );

-- ---------------------------------------------------------------------------
-- rounds / round_models: public competition reads from CREATED onward
-- (user decision: visible before OPEN; the dashboard filters client-side).
-- Lifecycle transitions are service-role-only.
-- ---------------------------------------------------------------------------
create policy rounds_public_read on public.rounds
  for select using (true);

create policy round_models_public_read on public.round_models
  for select using (true);

-- ---------------------------------------------------------------------------
-- predictions: own rows only for reads; the user may insert and edit their
-- pick with their own session while the round is OPEN (the insert/update
-- triggers re-validate round state and deadline). Column grants below narrow
-- UPDATE to model_id so points_awarded is never client-writable.
-- ---------------------------------------------------------------------------
create policy predictions_select_own on public.predictions
  for select using (user_id = auth.uid());

create policy predictions_insert_own on public.predictions
  for insert with check (user_id = auth.uid());

create policy predictions_update_own on public.predictions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke insert, update on public.predictions from anon, authenticated;
grant insert (round_id, user_id, category, model_id, commitment_hash)
  on public.predictions to authenticated;
grant update (model_id) on public.predictions to authenticated;

-- ---------------------------------------------------------------------------
-- evaluation + settlement + leaderboard: public competition/results reads
-- (issue #2 acceptance criterion). All writes are service-role-only.
-- ---------------------------------------------------------------------------
create policy model_executions_public_read on public.model_executions
  for select using (true);

create policy test_results_public_read on public.test_results
  for select using (true);

create policy competition_results_public_read on public.competition_results
  for select using (true);

create policy score_events_public_read on public.score_events
  for select using (true);

create policy user_scores_public_read on public.user_scores
  for select using (true);

-- ---------------------------------------------------------------------------
-- blockchain_transactions: user-owned linkage (which tx belongs to me).
-- Verification lookups that must span users go through the server API
-- (service role).
-- ---------------------------------------------------------------------------
create policy blockchain_transactions_select_own on public.blockchain_transactions
  for select using (user_id = auth.uid());
