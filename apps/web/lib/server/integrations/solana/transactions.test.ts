import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import bs58 from "bs58";
import {
  Keypair,
  SystemProgram,
  Transaction,
  type Connection,
} from "@solana/web3.js";
import {
  buildWagerTransaction,
  coSignVerifiedWager,
  MEMO_PROGRAM_ID,
} from "./transactions";
import { getSolanaEnv, parseKeypair } from "./config";

const fakeConnection = {
  getLatestBlockhash: async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000,
  }),
} as unknown as Connection;

async function prepare() {
  const operator = Keypair.generate();
  const user = Keypair.generate();
  const treasury = Keypair.generate();
  const prepared = await buildWagerTransaction({
    connection: fakeConnection,
    operator: operator.publicKey,
    user: user.publicKey,
    treasury: treasury.publicKey,
    lamports: BigInt(33_000_000),
    memo: "aisd:v2:wager:r:w:hash",
  });
  return { operator, user, treasury, prepared };
}

function walletSign(transactionB64: string, signer: Keypair): string {
  const tx = Transaction.from(Buffer.from(transactionB64, "base64"));
  tx.partialSign(signer);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

describe("wager transaction", () => {
  it("is one atomic transaction: priority fee, transfer, memo signed by the user", async () => {
    const { user, operator, treasury, prepared } = await prepare();
    const ixs = prepared.transaction.instructions;
    expect(ixs).toHaveLength(3);
    expect(ixs[1].programId.equals(SystemProgram.programId)).toBe(true);
    expect(ixs[1].keys[0].pubkey.equals(user.publicKey)).toBe(true);
    expect(ixs[1].keys[1].pubkey.equals(treasury.publicKey)).toBe(true);
    expect(ixs[2].programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(ixs[2].keys[0]).toMatchObject({ isSigner: true });
    expect(ixs[2].data.toString("utf8")).toBe("aisd:v2:wager:r:w:hash");
    expect(prepared.transaction.feePayer?.equals(operator.publicKey)).toBe(
      true,
    );
  });

  it("co-signs a faithfully signed copy and names the operator signature as the id", async () => {
    const { user, operator, prepared } = await prepare();
    const signed = walletSign(prepared.transactionB64, user);
    const result = coSignVerifiedWager({
      signedB64: signed,
      preparedMessageB64: prepared.messageB64,
      user: user.publicKey,
      operator,
    });
    expect(result.transaction.verifySignatures(true)).toBe(true);
    expect(result.signature).toBe(
      bs58.encode(result.transaction.signatures[0].signature!),
    );
  });

  it("refuses a copy whose amount was changed", async () => {
    const { user, operator, treasury, prepared } = await prepare();
    const tx = Transaction.from(Buffer.from(prepared.transactionB64, "base64"));
    tx.instructions[1] = SystemProgram.transfer({
      fromPubkey: user.publicKey,
      toPubkey: treasury.publicKey,
      lamports: 1,
    });
    tx.partialSign(user);
    expect(() =>
      coSignVerifiedWager({
        signedB64: tx
          .serialize({ requireAllSignatures: false })
          .toString("base64"),
        preparedMessageB64: prepared.messageB64,
        user: user.publicKey,
        operator,
      }),
    ).toThrow(/does not match/);
  });

  it("refuses an unsigned copy and a copy signed by another wallet", async () => {
    const { user, operator, prepared } = await prepare();
    expect(() =>
      coSignVerifiedWager({
        signedB64: prepared.transactionB64,
        preparedMessageB64: prepared.messageB64,
        user: user.publicKey,
        operator,
      }),
    ).toThrow(/missing your wallet's signature/);

    const tx = Transaction.from(Buffer.from(prepared.transactionB64, "base64"));
    const userIndex = tx.signatures.findIndex((s) =>
      s.publicKey.equals(user.publicKey),
    );
    tx.signatures[userIndex].signature = Buffer.alloc(64, 7);
    expect(() =>
      coSignVerifiedWager({
        signedB64: tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString("base64"),
        preparedMessageB64: prepared.messageB64,
        user: user.publicKey,
        operator,
      }),
    ).toThrow(/invalid/);
  });
});

describe("Devnet-only configuration", () => {
  it("refuses mainnet and testnet RPC URLs", () => {
    const previous = process.env.SOLANA_RPC_URL;
    process.env.SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
    expect(() => getSolanaEnv()).toThrow(/Devnet/);
    process.env.SOLANA_RPC_URL = "https://api.testnet.solana.com";
    expect(() => getSolanaEnv()).toThrow(/Devnet/);
    process.env.SOLANA_RPC_URL = previous;
  });

  it("parses keypairs without echoing the secret on failure", () => {
    const kp = Keypair.generate();
    expect(
      parseKeypair(
        "K",
        JSON.stringify(Array.from(kp.secretKey)),
      ).publicKey.equals(kp.publicKey),
    ).toBe(true);
    expect(
      parseKeypair("K", bs58.encode(kp.secretKey)).publicKey.equals(
        kp.publicKey,
      ),
    ).toBe(true);
    expect(() => parseKeypair("K", "not-a-key-abc")).toThrow(
      /K is not a valid/,
    );
    try {
      parseKeypair("K", "secret-value-xyz");
    } catch (error) {
      expect(String(error)).not.toContain("secret-value-xyz");
    }
  });
});
