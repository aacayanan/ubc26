import "server-only";

import { Connection } from "@solana/web3.js";
import { ConfigurationError } from "@/lib/server/errors/app-error";
import { DEVNET_GENESIS_HASH, getSolanaEnv } from "./config";

let cached: {
  url: string;
  connection: Connection;
  verified: Promise<void>;
} | null = null;

/**
 * A Devnet connection whose cluster has been proven by genesis hash.
 *
 * Every signing path awaits this, so a misconfigured RPC (mainnet behind an
 * innocuous URL) fails before a single signature is produced.
 */
export async function getDevnetConnection(): Promise<Connection> {
  const { rpcUrl } = getSolanaEnv();

  if (!cached || cached.url !== rpcUrl) {
    const connection = new Connection(rpcUrl, "confirmed");
    const verified = connection.getGenesisHash().then((hash) => {
      if (hash !== DEVNET_GENESIS_HASH) {
        throw new ConfigurationError(
          "The configured Solana RPC is not Devnet; refusing to sign anything",
        );
      }
    });
    cached = { url: rpcUrl, connection, verified };
  }

  try {
    await cached.verified;
  } catch (error) {
    // Do not cache a failed check (an RPC blip would otherwise stick).
    cached = null;
    throw error;
  }
  return cached.connection;
}
