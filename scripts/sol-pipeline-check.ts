/**
 * Live-cutoff check with REAL OpenRouter generation (no render sandbox needed).
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json ../../scripts/sol-pipeline-check.ts
 *
 * Creates a labelled SOL round (`e2e-cutoff-<ts>`) with one real Devnet ante,
 * then runs the actual F17 pipeline (`runRoundPipeline`, judge skipped). Preview
 * renders are best-effort, so without a render sandbox generation still runs
 * and the betting meter still decides the close for real.
 *
 * Asserts the "close, then publish" rule from stored timestamps: every chunk
 * whose cumulative token count reached the threshold was stored AFTER betting
 * closed, and every chunk stored while betting was open was below it.
 *
 * Then cancels the round and refunds the ante through the payout queue (real
 * Devnet transfer). Costs a few cents of model tokens; Devnet SOL has no value.
 */
import { randomBytes } from "node:crypto";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getDevnetConnection } from "@/lib/server/integrations/solana/connection";
import { explorerTxUrl, getTreasuryAddress, getTreasuryKeypair } from "@/lib/server/integrations/solana/config";
import { confirmSignature } from "@/lib/server/integrations/solana/transactions";
import { prepareWager, submitWager } from "@/lib/server/services/wagering/wagers";
import { refundCancelledRound } from "@/lib/server/services/wagering/refunds";
import { processPayouts } from "@/lib/server/services/wagering/payouts";
import { runRoundPipeline } from "@/lib/server/services/pipeline/run-round";
import { getChunkPolicy } from "@/lib/server/services/evaluation/chunk-policy";

const supabase = getServiceRoleSupabase();
const tag = `e2e-cutoff-${Date.now()}`;

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function transition(roundId: string, to: string) {
  const { error } = await supabase.rpc("transition_round", { p_round_id: roundId, p_to_status: to, p_reason: tag });
  if (error) throw new Error(`transition to ${to}: ${error.message}`);
}

async function main() {
  const connection = await getDevnetConnection();
  const treasury = getTreasuryKeypair();
  const policy = getChunkPolicy();
  const budget = policy.maxChunks * policy.maxTokensPerChunk;
  console.log(`▶ chunk policy ${policy.maxChunks} × ${policy.maxTokensPerChunk} = ${budget} tokens/model`);

  const { data: challenge } = await supabase.from("challenges").select("id").eq("status", "published").eq("language", "javascript").limit(1).single();
  const { data: models } = await supabase.from("llm_models").select("id, name").eq("is_active", true).eq("role", "competitor").order("sort_order").limit(3);
  check(challenge && models && models.length >= 2, `a published brief and ${models?.length} active competitor models`);

  // One bettor with a real Devnet ante, so the cancellation refund is real too.
  const keypair = Keypair.generate();
  const { data: created, error: userError } = await supabase.auth.admin.createUser({
    email: `${tag}@ai-showdown.test`, password: randomBytes(18).toString("base64url"), email_confirm: true,
  });
  if (userError || !created.user) throw new Error(`createUser: ${userError?.message}`);
  const user = created.user;
  await supabase.from("users").upsert({ id: user.id, display_name: tag });
  await supabase.from("wallets").insert({ user_id: user.id, address: keypair.publicKey.toBase58() });
  {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const fund = new Transaction({ feePayer: treasury.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: keypair.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL }),
    );
    fund.sign(treasury);
    const sig = await connection.sendRawTransaction(fund.serialize());
    check((await confirmSignature({ connection, signature: sig, lastValidBlockHeight })).kind === "confirmed", "bettor funded");
  }

  const { data: round, error: roundError } = await supabase.rpc("create_sol_competition", {
    p_slug: tag, p_challenge_id: challenge!.id, p_model_ids: models!.map((m) => m.id),
    p_prediction_deadline: new Date(Date.now() + 10 * 60_000).toISOString(), p_created_by: null,
    p_treasury_address: getTreasuryAddress(), p_token_budget_per_model: budget, p_fee_bps: 500,
    p_stall_timeout_seconds: 120,
  });
  if (roundError) throw new Error(roundError.message);
  const roundId = (round as { id: string }).id;
  console.log(`▶ round ${tag} (${roundId})`);

  const prepared = await prepareWager({ user, roundId, modelId: models![0].id, kind: "ante", connectedWallet: keypair.publicKey.toBase58() });
  const tx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
  tx.partialSign(keypair);
  const ante = await submitWager({ userId: user.id, wagerId: prepared.wagerId, signedTransaction: tx.serialize({ requireAllSignatures: false }).toString("base64") });
  check(ante.status === "accepted", `ante accepted on Devnet (${prepared.lamports} lamports)`);

  await transition(roundId, "LOCKED");
  console.log("▶ running the real pipeline (OpenRouter generation; judge skipped)…");
  const started = Date.now();
  try {
    await runRoundPipeline({ roundId, correlationId: tag, skipJudge: true });
  } catch (error) {
    console.log(`  (pipeline ended with: ${error instanceof Error ? error.message.slice(0, 120) : error})`);
  }
  console.log(`  pipeline took ${Math.round((Date.now() - started) / 1000)} s`);

  const { data: after } = await supabase
    .from("rounds")
    .select("status, betting_phase, betting_closed_at, betting_close_reason, betting_close_model_id, betting_close_snapshot, live_started_at")
    .eq("id", roundId).single();
  check(after!.betting_phase === "closed", `betting closed — reason: ${after!.betting_close_reason}`);
  check(after!.status !== "EVALUATING" || after!.betting_phase === "closed", "no evaluation while betting was open");
  console.log(`    close model: ${models!.find((m) => m.id === after!.betting_close_model_id)?.name ?? "—"}`);
  console.log(`    snapshot: ${JSON.stringify(after!.betting_close_snapshot)}`);

  const closedAt = Date.parse(after!.betting_closed_at as string);
  const threshold = Math.ceil((budget * 7500) / 10_000);
  const { data: executions } = await supabase.from("model_executions").select("id, model_id, status").eq("round_id", roundId).eq("run_type", "generation");
  let violations = 0;
  for (const execution of executions ?? []) {
    const { data: chunks } = await supabase.from("generation_chunks").select("chunk_index, output_tokens, source, created_at").eq("execution_id", execution.id).order("chunk_index");
    let cumulative = 0;
    const name = models!.find((m) => m.id === execution.model_id)?.name;
    for (const chunk of chunks ?? []) {
      cumulative += typeof chunk.output_tokens === "number" ? chunk.output_tokens : Math.ceil(String(chunk.source).length / 3);
      const storedAt = Date.parse(chunk.created_at as string);
      const beforeClose = storedAt < closedAt;
      console.log(`    ${name} chunk ${chunk.chunk_index}: cumulative ${cumulative} tokens, stored ${beforeClose ? "BEFORE" : "after"} close`);
      if (beforeClose && cumulative >= threshold) violations += 1;
    }
  }
  check(violations === 0, `no chunk at or past the ${threshold}-token threshold was stored while betting was open`);

  // Refund path: cancel and refund the ante for real.
  const { data: now } = await supabase.from("rounds").select("status").eq("id", roundId).single();
  if (now!.status === "RUNNING" || now!.status === "FAILED" || now!.status === "LOCKED") {
    await transition(roundId, "CANCELLED");
  } else if (now!.status === "EVALUATING" || now!.status === "RETRYING") {
    await transition(roundId, "FAILED");
    await transition(roundId, "CANCELLED");
  }
  const refund = await refundCancelledRound(roundId);
  check(refund.kind === "refund", `refund recorded: ${refund.grossLamports} lamports, fee ${refund.feeLamports}`);
  const balanceBefore = await connection.getBalance(keypair.publicKey);
  const run = await processPayouts({ roundId });
  check(run.confirmed === 1, `refund paid: ${JSON.stringify(run)}`);
  const gained = (await connection.getBalance(keypair.publicKey)) - balanceBefore;
  check(BigInt(gained) === BigInt(prepared.lamports), `bettor got the full ante back on-chain (${gained} lamports)`);
  const { data: payout } = await supabase.from("payouts").select("signature").eq("round_id", roundId).single();
  console.log(`    ${explorerTxUrl(payout!.signature as string)}`);
  console.log(`\n✓ Live-cutoff check passed for round ${tag}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
