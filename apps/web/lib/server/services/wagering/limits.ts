/**
 * Devnet wager safeguards. The database (`public.sol_wager_limits()` and
 * `wager_reserve`) is authoritative; these mirror it for early, friendly errors
 * and for the UI.
 */
export const WAGER_LIMITS = {
  minLiveLamports: BigInt(5_000_000), // 0.005 SOL
  maxLiveLamports: BigInt(250_000_000), // 0.25 SOL
  maxLiveWagersPerRound: 10,
  maxLamportsPerRound: BigInt(1_000_000_000), // 1 SOL, ante included
  maxPreparedPerMinute: 5,
} as const;
