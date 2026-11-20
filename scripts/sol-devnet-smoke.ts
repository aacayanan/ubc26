/**
 * Real Devnet smoke test for the SOL wager transaction path (no database).
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server --env-file=.env.local ../../scripts/sol-devnet-smoke.ts
 *
 * What it proves, on the actual Devnet cluster:
 *   1. the RPC is Devnet (genesis hash) before anything is signed
 *   2. a wager transaction = System transfer + Memo, atomic, operator fee payer
 *   3. a "user" keypair signs it (standing in for Phantom's signTransaction)
 *   4. a tampered copy is refused before the operator co-signs
 *   5. the co-signed transaction lands, and verifyLandedWager re-reads it from
 *      chain and confirms message bytes + treasury delta
 *   6. a treasury payout transfer (with memo) lands back to the user
 *
 * Needs SOLANA_OPERATOR_KEYPAIR and SOLANA_TREASURY_KEYPAIR funded with Devnet
 * test SOL (https://faucet.solana.com). The throwaway "user" is funded from the
 * treasury, so only those two need SOL. Every amount here is valueless.
 */
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { getDevnetConnection } from "@/lib/server/integrations/solana/connection";
import {
  explorerTxUrl,
  getOperatorKeypair,
  getTreasuryKeypair,
} from "@/lib/server/integrations/solana/config";
import {
  buildPayoutTransaction,
  buildWagerTransaction,
  coSignVerifiedWager,
  confirmSignature,
  verifyLandedWager,
} from "@/lib/server/integrations/solana/transactions";

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function main() {
  const connection = await getDevnetConnection();
  console.log("▶ Devnet confirmed by genesis hash");

  const operator = getOperatorKeypair();
  const treasury = getTreasuryKeypair();
  const opBalance = await connection.getBalance(operator.publicKey);
  const trBalance = await connection.getBalance(treasury.publicKey);
  console.log(
    `  operator ${operator.publicKey.toBase58()} ${opBalance / LAMPORTS_PER_SOL} SOL`,
  );
  console.log(
    `  treasury ${treasury.publicKey.toBase58()} ${trBalance / LAMPORTS_PER_SOL} SOL`,
  );
  check(opBalance >= 0.01 * LAMPORTS_PER_SOL, "operator holds fee SOL");
  check(trBalance >= 0.1 * LAMPORTS_PER_SOL, "treasury holds at least 0.1 SOL");

  // A throwaway bettor, funded from the treasury.
  const user = Keypair.generate();
  {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    const fund = new Transaction({
      feePayer: treasury.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(
      SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: user.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      }),
    );
    fund.sign(treasury);
    const sig = await connection.sendRawTransaction(fund.serialize());
    const outcome = await confirmSignature({
      connection,
      signature: sig,
      lastValidBlockHeight,
    });
    check(
      outcome.kind === "confirmed" && !outcome.failed,
      "test bettor funded with 0.05 Devnet SOL",
    );
  }

  const lamports = BigInt(20_000_000); // 0.02 SOL
  const memo = `aisd:v2:wager:smoke:${Date.now()}:${"0".repeat(64)}`;
  const prepared = await buildWagerTransaction({
    connection,
    operator: operator.publicKey,
    user: user.publicKey,
    treasury: treasury.publicKey,
    lamports,
    memo,
  });
  console.log("▶ wager prepared (transfer + memo, operator fee payer)");

  // The "wallet" signs only its own part.
  const forWallet = Transaction.from(
    Buffer.from(prepared.transactionB64, "base64"),
  );
  forWallet.partialSign(user);
  const signedB64 = forWallet
    .serialize({ requireAllSignatures: false })
    .toString("base64");

  // Tampering is refused before co-signing.
  const tampered = Transaction.from(
    Buffer.from(prepared.transactionB64, "base64"),
  );
  tampered.instructions[1] = SystemProgram.transfer({
    fromPubkey: user.publicKey,
    toPubkey: treasury.publicKey,
    lamports: 1,
  });
  tampered.partialSign(user);
  let refused = false;
  try {
    coSignVerifiedWager({
      signedB64: tampered
        .serialize({ requireAllSignatures: false })
        .toString("base64"),
      preparedMessageB64: prepared.messageB64,
      user: user.publicKey,
      operator,
    });
  } catch {
    refused = true;
  }
  check(refused, "a tampered transaction is refused before the operator signs");

  const { signature, raw } = coSignVerifiedWager({
    signedB64,
    preparedMessageB64: prepared.messageB64,
    user: user.publicKey,
    operator,
  });
  await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 0,
  });
  const confirmed = await confirmSignature({
    connection,
    signature,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
    raw,
  });
  check(
    confirmed.kind === "confirmed" && !confirmed.failed,
    "the wager confirmed on Devnet",
  );

  const landed = await verifyLandedWager({
    connection,
    signature,
    preparedMessageB64: prepared.messageB64,
    treasury: treasury.publicKey,
    lamports,
  });
  check(
    landed.ok,
    `on-chain verification: message bytes match and treasury gained ${landed.treasuryDelta} lamports`,
  );
  console.log(`  wager tx: ${explorerTxUrl(signature)}`);

  const payout = await buildPayoutTransaction({
    connection,
    treasury,
    recipient: user.publicKey,
    lamports: BigInt(19_000_000),
    memo: "aisd:v2:payout:smoke:test",
  });
  await connection.sendRawTransaction(payout.raw, {
    skipPreflight: false,
    maxRetries: 0,
  });
  const paid = await confirmSignature({
    connection,
    signature: payout.signature,
    lastValidBlockHeight: payout.lastValidBlockHeight,
    raw: payout.raw,
  });
  check(
    paid.kind === "confirmed" && !paid.failed,
    "a treasury payout confirmed on Devnet",
  );
  console.log(`  payout tx: ${explorerTxUrl(payout.signature)}`);

  console.log("\n✓ Devnet smoke test passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
