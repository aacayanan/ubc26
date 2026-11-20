-- Retire the points pool (2026-11-20). Every new round wagers Devnet SOL.
--
-- The app no longer creates points rounds or accepts points stakes; the
-- leaderboard and dashboard count correct Devnet SOL predictions
-- (`wagers.settlement_outcome = 'won'`) instead of points or streaks.
-- Legacy points tables and columns are left in place for history.

alter table public.rounds alter column wagering_mode set default 'devnet_sol';

comment on column public.rounds.wagering_mode is
  'devnet_sol = valueless Devnet SOL wagers (the only mode the app creates). points = retired legacy pool, kept for history. Mainnet is never a mode.';
