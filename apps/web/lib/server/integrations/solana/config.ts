import "server-only";

import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { ConfigurationError } from "@/lib/server/errors/app-error";

/**
 * Solana configuration — Devnet only (2026-11-20 SOL wagering prototype).
 *
 * Two keypairs, deliberately separate:
 *   - operator: fee payer and required co-signer on every wager; signs the
 *     round, close and settlement memos. Holds only enough SOL for fees.
 *   - treasury: receives wagers and signs payouts/refunds.
 *
 * Both are server-only secrets (JSON byte array as written by
 * `solana-keygen`, or base58). They are read on demand so a deployment without
 * them still renders pages; only the wagering paths fail.
 *
 * Mainnet is impossible by construction: `assertDevnet` (connection.ts) checks
 * the RPC's genesis hash against Devnet's before anything is signed, and URLs
 * naming mainnet are refused here outright.
 */

export const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEFAULT_DEVNET_RPC_URL = "https://api.devnet.solana.com";

export interface SolanaEnv {
  rpcUrl: string;
}

export function getSolanaEnv(): SolanaEnv {
  const rpcUrl = (process.env.SOLANA_RPC_URL ?? DEFAULT_DEVNET_RPC_URL).trim();

  if (!/^https?:\/\//.test(rpcUrl)) {
    throw new ConfigurationError("SOLANA_RPC_URL must be an http(s) URL");
  }
  if (/mainnet|testnet/i.test(rpcUrl)) {
    throw new ConfigurationError(
      "SOLANA_RPC_URL must point at Solana Devnet; mainnet and testnet are refused",
    );
  }
  return { rpcUrl };
}

export function parseKeypair(name: string, raw: string | undefined): Keypair {
  if (!raw || raw.trim() === "") {
    throw new ConfigurationError(`Missing ${name}`);
  }
  const value = raw.trim();
  try {
    if (value.startsWith("[")) {
      const bytes = Uint8Array.from(JSON.parse(value) as number[]);
      return Keypair.fromSecretKey(bytes);
    }
    return Keypair.fromSecretKey(bs58.decode(value));
  } catch {
    // Never echo the value: it is a private key.
    throw new ConfigurationError(`${name} is not a valid Solana secret key`);
  }
}

let operator: Keypair | null = null;
let treasury: Keypair | null = null;

export function getOperatorKeypair(): Keypair {
  operator ??= parseKeypair(
    "SOLANA_OPERATOR_KEYPAIR",
    process.env.SOLANA_OPERATOR_KEYPAIR,
  );
  return operator;
}

export function getTreasuryKeypair(): Keypair {
  treasury ??= parseKeypair(
    "SOLANA_TREASURY_KEYPAIR",
    process.env.SOLANA_TREASURY_KEYPAIR,
  );
  if (operator && treasury.publicKey.equals(operator.publicKey)) {
    throw new ConfigurationError(
      "The treasury and operator keypairs must differ",
    );
  }
  return treasury;
}

/** Public treasury address, safe to show and to store on a round. */
export function getTreasuryAddress(): string {
  return getTreasuryKeypair().publicKey.toBase58();
}

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}
