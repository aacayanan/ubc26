import type { User } from "@supabase/supabase-js";

/**
 * Phantom (Sign in with Solana) accounts finish setup by choosing a username
 * and password, so they can sign back in without the wallet.
 *
 * Supabase password auth is keyed on an email, and a wallet account has none.
 * The username therefore maps to a private login address on the reserved
 * `.invalid` TLD (RFC 2606): it can never receive mail, it is confirmed by the
 * server when set, and the user never sees it. The mapping is deterministic,
 * so the sign-in form can resolve a username without a lookup.
 */
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
export const USERNAME_RULE =
  "3–20 characters: letters, numbers and underscores.";
export const MIN_PASSWORD_LENGTH = 8;

const LOGIN_DOMAIN = "wallet.ai-showdown.invalid";

export function usernameToLoginEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${LOGIN_DOMAIN}`;
}

/** True for an account that signed in with a wallet and has no password login yet. */
export function needsAccountSetup(user: User | null | undefined): boolean {
  if (!user) return false;
  const hasWalletIdentity = (user.identities ?? []).some(
    (identity) => identity.provider === "web3",
  );
  return hasWalletIdentity && !user.email;
}
