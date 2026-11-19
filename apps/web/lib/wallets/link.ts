import type { SupabaseClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";

export interface WalletLink {
  address: string;
  verifiedAt: string | null;
}

interface SolanaProviderLike {
  publicKey?: { toBase58: () => string } | null;
}

/**
 * The wallet address this account linked, if any.
 *
 * Signing in with Solana (email/password users) and linking are different
 * actions: a Solana sign-in creates a wallet-keyed user, while an email user
 * attaches an address to their existing account through `linkWallet`.
 */
export async function getLinkedWallet(
  supabase: SupabaseClient,
): Promise<WalletLink | null> {
  const { data, error } = await supabase
    .from("wallets")
    .select("address, verified_at")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return { address: data.address, verifiedAt: data.verified_at };
}

/** Read the connected wallet's public address, requesting access if needed. */
export async function getWalletAddress(): Promise<string | null> {
  const provider = window.solana;
  if (!provider) return null;

  const existing = getPublicKeyAddress(provider);
  if (existing) return existing;

  // Existing Phantom sessions may already be trusted; otherwise prompt.
  const connect = (
    provider as unknown as { connect?: () => Promise<{ publicKey?: unknown }> }
  ).connect;
  if (!connect) return null;

  try {
    const result = await connect.call(provider);
    const key = result?.publicKey;
    if (key && typeof key === "object" && "toBase58" in key) {
      return (key as { toBase58: () => string }).toBase58();
    }
  } catch {
    return null;
  }

  // Some wallets populate publicKey only after connect() resolves.
  return getPublicKeyAddress(provider);
}

function getPublicKeyAddress(provider: SolanaProviderLike): string | null {
  const key = provider.publicKey;
  return key ? key.toBase58() : null;
}

/**
 * Attach a wallet address to the signed-in account.
 *
 * The row is inserted under RLS with the user's own session, so the
 * `user_id = auth.uid()` policy is what enforces ownership. Ownership proof
 * (`verified_at`) lands with the commitment work (F20).
 */
export async function linkWallet(
  supabase: SupabaseClient,
  user: User,
  address: string,
): Promise<WalletLink> {
  const { data, error } = await supabase
    .from("wallets")
    .upsert(
      { user_id: user.id, address, chain: "solana", cluster: "devnet" },
      { onConflict: "user_id" },
    )
    .select("address, verified_at")
    .single();

  if (error) throw error;
  return { address: data.address, verifiedAt: data.verified_at };
}
