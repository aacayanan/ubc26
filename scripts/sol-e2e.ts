/**
 * End-to-end SOL wagering check — real Devnet + the hosted Supabase project.
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json ../../scripts/sol-e2e.ts
 *
 * Exercises the production code paths (prepareWager, submitWager, closeBetting,
 * recordSolSettlement, processPayouts) with two throwaway test accounts whose
 * keypairs stand in for Phantom's signTransaction. Generation and judging are
 * NOT run here (they cost model tokens and need the render sandbox): the script
 * closes betting itself with reason `token_threshold` and declares model A the
 * sole conformer, then settles. Everything else is real: Devnet transfers,
 * on-chain verification, database windows, payouts.
 *
 * Creates clearly labelled rows: round slug `e2e-sol-<ts>`, users
 * `e2e-sol-<ts>-<n>@ai-showdown.test`. Devnet SOL only; it has no value.
 */
import { randomBytes } from "node:crypto";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getDevnetConnection } from "@/lib/server/integrations/solana/connection";
import {
  explorerTxUrl,
  getOperatorKeypair,
  getTreasuryAddress,
  getTreasuryKeypair,
} from "@/lib/server/integrations/solana/config";
import { confirmSignature } from "@/lib/server/integrations/solana/transactions";
import { prepareWager, submitWager } from "@/lib/server/services/wagering/wagers";
import { closeBetting } from "@/lib/server/services/wagering/betting";
import { recordSolSettlement } from "@/lib/server/services/wagering/sol-settlement";
import { processPayouts } from "@/lib/server/services/wagering/payouts";
import { getPoolView } from "@/lib/server/services/wagering/pool";
import { WAGER_LIMITS } from "@/lib/server/services/wagering/limits";
import { quoteLiveMinimum } from "@/lib/server/services/wagering/quote";

const supabase = getServiceRoleSupabase();
const tag = `e2e-sol-${Date.now()}`;

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function expectFailure(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.log(`  ✓ ${label} (${error instanceof Error ? error.message.slice(0, 90) : "error"})`);
    return;
  }
  throw new Error(`FAIL: ${label} — it was accepted`);
}

function walletSign(transactionB64: string, signer: Keypair): string {
  const tx = Transaction.from(Buffer.from(transactionB64, "base64"));
  tx.partialSign(signer);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

async function transition(roundId: string, to: string) {
  const { error } = await supabase.rpc("transition_round", {
    p_round_id: roundId,
    p_to_status: to,
    p_reason: `${tag} e2e`,
  });
  if (error) throw new Error(`transition to ${to}: ${error.message}`);
}

async function main() {
  const connection = await getDevnetConnection();
  const operator = getOperatorKeypair();
  const treasury = getTreasuryKeypair();
  console.log("▶ Devnet confirmed by genesis hash");
  check((await connection.getBalance(operator.publicKey)) >= 0.05 * LAMPORTS_PER_SOL, "operator funded");
  check((await connection.getBalance(treasury.publicKey)) >= 0.5 * LAMPORTS_PER_SOL, "treasury funded");

  // Fixtures --------------------------------------------------------------
  const { data: challenge } = await supabase
    .from("challenges").select("id").eq("status", "published").limit(1).single();
  const { data: models } = await supabase
    .from("llm_models").select("id, name").eq("is_active", true).eq("role", "competitor").order("sort_order").limit(2);
  check(challenge && models && models.length === 2, "a published brief and two active models exist");
  const [modelA, modelB] = models!;

  const bettors: Array<{ keypair: Keypair; user: Awaited<ReturnType<typeof createBettor>> }> = [];
  async function createBettor(n: number) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: `${tag}-${n}@ai-showdown.test`,
      password: randomBytes(18).toString("base64url"),
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
    return data.user;
  }

  for (const n of [1, 2]) {
    const keypair = Keypair.generate();
    const user = await createBettor(n);
    await supabase.from("users").upsert({ id: user.id, display_name: `${tag}-${n}` });
    const { error } = await supabase.from("wallets").insert({ user_id: user.id, address: keypair.publicKey.toBase58() });
    if (error) throw new Error(`wallet: ${error.message}`);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const fund = new Transaction({ feePayer: treasury.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: keypair.publicKey, lamports: 0.15 * LAMPORTS_PER_SOL }),
    );
    fund.sign(treasury);
    const sig = await connection.sendRawTransaction(fund.serialize());
    const funded = await confirmSignature({ connection, signature: sig, lastValidBlockHeight });
    check(funded.kind === "confirmed", `bettor ${n} funded with 0.15 Devnet SOL`);
    bettors.push({ keypair, user });
  }

  const { data: round, error: roundError } = await supabase.rpc("create_sol_competition", {
    p_slug: tag,
    p_challenge_id: challenge!.id,
    p_model_ids: [modelA.id, modelB.id],
    p_prediction_deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    p_created_by: null,
    p_treasury_address: getTreasuryAddress(),
    p_token_budget_per_model: 6144,
    p_fee_bps: 500,
  });
  if (roundError) throw new Error(`create_sol_competition: ${roundError.message}`);
  const roundId = (round as { id: string }).id;
  console.log(`▶ round ${tag} (${roundId}) — ante open`);

  // Ante ------------------------------------------------------------------
  const picks = [modelA.id, modelB.id];
  for (const [i, bettor] of bettors.entries()) {
    const prepared = await prepareWager({
      user: bettor.user,
      roundId,
      modelId: picks[i],
      kind: "ante",
      connectedWallet: bettor.keypair.publicKey.toBase58(),
    });
    const result = await submitWager({
      userId: bettor.user.id,
      wagerId: prepared.wagerId,
      signedTransaction: walletSign(prepared.transaction, bettor.keypair),
    });
    check(result.status === "accepted", `bettor ${i + 1} ante ${prepared.lamports} lamports accepted (quote ${prepared.quote?.source} @ $${prepared.quote?.price})`);
    console.log(`    ${result.explorerUrl}`);
  }

  await expectFailure("a duplicate ante is refused", async () => {
    const prepared = await prepareWager({
      user: bettors[0].user, roundId, modelId: modelB.id, kind: "ante",
      connectedWallet: bettors[0].keypair.publicKey.toBase58(),
    });
    await submitWager({
      userId: bettors[0].user.id, wagerId: prepared.wagerId,
      signedTransaction: walletSign(prepared.transaction, bettors[0].keypair),
    });
  });

  await expectFailure("a live wager before generation is refused", () =>
    prepareWager({
      user: bettors[0].user, roundId, modelId: modelB.id, kind: "live", lamports: BigInt(10_000_000),
      connectedWallet: bettors[0].keypair.publicKey.toBase58(),
    }),
  );

  // Live ------------------------------------------------------------------
  await transition(roundId, "LOCKED");
  await transition(roundId, "RUNNING");
  const live = await getPoolView(roundId);
  check(live.bettingPhase === "live", "RUNNING opened live betting");

  // Live wagers are priced in dollars: at least $3 in SOL after the ante.
  const liveMin = BigInt(
    (await quoteLiveMinimum(WAGER_LIMITS.minLiveUsdCents)).minLamports,
  );
  await expectFailure("a live wager under $3 is refused", () =>
    prepareWager({
      user: bettors[0].user, roundId, modelId: modelB.id, kind: "live", lamports: liveMin - BigInt(1),
      connectedWallet: bettors[0].keypair.publicKey.toBase58(),
    }),
  );

  for (const [i, amount] of [liveMin + BigInt(1_000_000), liveMin + BigInt(2_000_000)].entries()) {
    const bettor = bettors[i];
    const prepared = await prepareWager({
      user: bettor.user, roundId, modelId: i === 0 ? modelB.id : modelA.id, kind: "live", lamports: amount,
      connectedWallet: bettor.keypair.publicKey.toBase58(),
    });
    const result = await submitWager({
      userId: bettor.user.id, wagerId: prepared.wagerId,
      signedTransaction: walletSign(prepared.transaction, bettor.keypair),
    });
    check(result.status === "accepted", `bettor ${i + 1} live wager ${amount} lamports accepted`);
  }

  await expectFailure("a tampered live wager is refused before co-signing", async () => {
    const prepared = await prepareWager({
      user: bettors[0].user, roundId, modelId: modelA.id, kind: "live", lamports: liveMin,
      connectedWallet: bettors[0].keypair.publicKey.toBase58(),
    });
    const tx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
    tx.instructions[1] = SystemProgram.transfer({ fromPubkey: bettors[0].keypair.publicKey, toPubkey: treasury.publicKey, lamports: 1 });
    tx.partialSign(bettors[0].keypair);
    await submitWager({
      userId: bettors[0].user.id, wagerId: prepared.wagerId,
      signedTransaction: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    });
  });

  const before = await getPoolView(roundId);
  console.log(`    pool ${before.grossLamports} lamports; est. multipliers ${before.models.map((m) => m.multiplier).join(" / ")}`);

  // Cutoff ----------------------------------------------------------------
  await closeBetting({ roundId, reason: "token_threshold", modelId: modelA.id, snapshot: null });
  check((await getPoolView(roundId)).bettingPhase === "closed", "betting closed (token_threshold)");
  await expectFailure("a live wager after the cutoff is refused", () =>
    prepareWager({
      user: bettors[1].user, roundId, modelId: modelB.id, kind: "live", lamports: liveMin,
      connectedWallet: bettors[1].keypair.publicKey.toBase58(),
    }),
  );

  // Settlement ------------------------------------------------------------
  await transition(roundId, "EVALUATING");
  const settlement = await recordSolSettlement({
    roundId, conformedModelIds: [modelA.id], modelOrder: [modelA.id, modelB.id], voided: false, supabase,
  });
  check(settlement.kind === "settled", `settlement recorded: gross ${settlement.grossLamports}, fee ${settlement.feeLamports}, net ${settlement.netLamports}`);
  const again = await recordSolSettlement({
    roundId, conformedModelIds: [modelB.id], modelOrder: [modelA.id, modelB.id], voided: false, supabase,
  });
  check(again.alreadyRecorded === true || again.kind === "settled", "a second settlement returns the first (write-once)");

  const balancesBefore = await Promise.all(bettors.map((b) => connection.getBalance(b.keypair.publicKey)));
  const run = await processPayouts({ roundId });
  check(run.confirmed >= 1 && run.blocked === 0, `payout run: ${JSON.stringify(run)}`);
  const rerun = await processPayouts({ roundId });
  check(rerun.confirmed === 0 && rerun.failed === 0, "a second payout run sends nothing (no double pay)");

  const { data: payouts } = await supabase.from("payouts").select("user_id, lamports, status, signature").eq("round_id", roundId);
  for (const payout of payouts ?? []) {
    check(payout.status === "confirmed", `payout ${payout.lamports} lamports confirmed`);
    console.log(`    ${explorerTxUrl(payout.signature as string)}`);
  }
  const balancesAfter = await Promise.all(bettors.map((b) => connection.getBalance(b.keypair.publicKey)));
  const paidTotal = (payouts ?? []).reduce((sum, p) => sum + BigInt(p.lamports as string | number), BigInt(0));
  const gained = balancesAfter.reduce((s, b, i) => s + BigInt(b - balancesBefore[i]), BigInt(0));
  check(gained === paidTotal, `bettor wallets gained exactly the payout total on-chain (${gained} lamports)`);
  check(paidTotal + BigInt(settlement.feeLamports as string) === BigInt(settlement.grossLamports as string), "payouts + fee = gross pool");

  const { error: settleError } = await supabase.rpc("settle_round", {
    p_round_id: roundId, p_kind: "settled", p_winner_model_id: modelA.id, p_fan_favorite_model_id: null,
    p_tie_break: "sole-conformer", p_reason: `${tag}: e2e settlement`, p_all_forfeited: false,
    p_results: [], p_stakes: [], p_awards: [],
  });
  check(!settleError, `round settled${settleError ? `: ${settleError.message}` : ""}`);

  const { data: memos } = await supabase.from("blockchain_transactions").select("purpose, status, signature").eq("round_id", roundId);
  console.log(`    operator memos so far: ${JSON.stringify(memos)}`);
  console.log(`\n✓ End-to-end SOL wagering check passed for round ${tag}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
