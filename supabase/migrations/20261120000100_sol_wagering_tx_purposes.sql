-- SOL wagering (Devnet prototype, 2026-11-20): new transaction purposes.
--
-- Kept in its own migration because `alter type ... add value` cannot be used
-- by statements in the same transaction that adds it. Nothing here uses the new
-- values; 20261120000200 and the app do.
--
--   wager          a user-signed SOL transfer + Memo commitment (ante or live)
--   payout         an operator-signed winnings or refund transfer
--   betting_close  the operator memo recording when and why betting closed

alter type public.tx_purpose add value if not exists 'wager';
alter type public.tx_purpose add value if not exists 'payout';
alter type public.tx_purpose add value if not exists 'betting_close';
