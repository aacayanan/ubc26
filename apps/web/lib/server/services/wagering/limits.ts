/**
 * Devnet wager safeguards. The database (`public.sol_wager_limits()` and
 * `wager_reserve`) is authoritative; these mirror it for early, friendly errors
 * and for the UI.
 */
export const WAGER_LIMITS = {
  // After the $5 ante, each live wager must be worth at least $3 in SOL at
  // the reference price. Checked at prepare (the database has no price); the
  // signed transaction must equal the prepared one, so the amount cannot
  // change afterwards. There is no maximum per wager or per round.
  minLiveUsdCents: 300,
  maxLiveWagersPerRound: 10,
  maxPreparedPerMinute: 5,
} as const;
