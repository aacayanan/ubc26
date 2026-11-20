// Minimal typing for the Solana wallet provider injected by Phantom.
// Supabase's signInWithWeb3({ chain: "solana" }) reads window.solana by
// default; we declare only what the sign-in flow touches.

interface SolanaProviderPublicKey {
  toBase58: () => string;
}

interface SolanaSignInInput {
  domain?: string;
  address?: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

interface SolanaSignInOutput {
  account: { publicKey: SolanaProviderPublicKey; [key: string]: unknown };
  signedMessage: Uint8Array;
  signature: Uint8Array;
}

interface SolanaProvider {
  isPhantom?: boolean;
  publicKey?: SolanaProviderPublicKey | null;
  signIn?: (
    input?: SolanaSignInInput,
  ) => Promise<SolanaSignInOutput | SolanaSignInOutput[]>;
  signMessage?: (
    message: Uint8Array,
    encoding?: string,
  ) => Promise<{ signature: Uint8Array }>;
  connect?: (options?: {
    onlyIfTrusted?: boolean;
  }) => Promise<{ publicKey: SolanaProviderPublicKey }>;
  /**
   * Sign only — the SOL wager flow never lets the wallet broadcast. The server
   * checks the bytes, co-signs as fee payer and submits (2026-11-20).
   */
  signTransaction?: <T>(transaction: T) => Promise<T>;
}

interface Window {
  solana?: SolanaProvider;
}
