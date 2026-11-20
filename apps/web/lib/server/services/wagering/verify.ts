import "server-only";

import { PublicKey, type Connection } from "@solana/web3.js";
import { InternalError, NotFoundError } from "@/lib/server/errors/app-error";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getDevnetConnection } from "@/lib/server/integrations/solana/connection";
import { explorerTxUrl } from "@/lib/server/integrations/solana/config";
import { MEMO_PROGRAM_ID } from "@/lib/server/integrations/solana/transactions";
import { commitmentHash, wagerMemo } from "./commitment";

/**
 * F20 — verify a wager's commitment against Solana Devnet.
 *
 * What a pass proves (and what it does not):
 *   - the transaction exists on Devnet, succeeded, and was signed by the
 *     account's wallet;
 *   - its memo is exactly `aisd:v2:wager:<round>:<wager>:<hash>` — the hash
 *     only, never the pick or the nonce;
 *   - the treasury received exactly the wagered lamports;
 *   - the network-assigned block time falls inside the wager's window;
 *   - the stored preimage (round, wager, model, lamports, nonce) re-hashes to
 *     that same hash, so the pick could not have been changed afterwards.
 * It does NOT prove that model execution, judging or settlement were honest —
 * those still rest on the backend.
 *
 * Timing boundary. The server reserves a wager under the round lock only while
 * its window is open: an ante while `now() <= prediction_deadline`, a live
 * wager while `betting_phase = 'live'` (closing sets `betting_closed_at`).
 * Reservation happens before broadcast, and the transaction carries a blockhash
 * fetched before that, which the network stops accepting after ~150 blocks
 * (about a minute). So any wager that passed reservation lands no later than
 * `boundary + LANDING_GRACE_SECONDS` or never lands at all. Verification checks
 * the chain's block time against that same boundary plus the grace, so a wager
 * cannot pass the server's check and then fail verification. The grace also
 * absorbs the validator-estimated skew in `blockTime`.
 */
export const LANDING_GRACE_SECONDS = 120;

export type CheckId =
  | "on_chain"
  | "signer"
  | "memo"
  | "hash_only"
  | "transfer"
  | "on_time"
  | "preimage";

export interface CommitmentCheck {
  id: CheckId;
  label: string;
  ok: boolean;
  detail: string;
}

/** What the chain says about one transaction, reduced to what we check. */
export interface LandedCommitment {
  found: boolean;
  failed: boolean;
  error: string | null;
  memos: string[];
  signers: string[];
  treasuryDelta: bigint;
  blockTime: string | null;
  slot: number | null;
}

export interface StoredWager {
  id: string;
  roundId: string;
  modelId: string;
  kind: "ante" | "live";
  lamports: bigint;
  walletAddress: string;
  commitmentHash: string;
  nonce: string;
}

export interface WagerWindow {
  /** The round's ante deadline (`prediction_deadline`). */
  anteDeadline: string;
  /** When live betting closed; null while it is still open. */
  bettingClosedAt: string | null;
}

/** The deadline a wager of this kind had to beat, or null when still open. */
export function wagerBoundary(
  kind: StoredWager["kind"],
  window: WagerWindow,
): { at: string | null; label: string } {
  return kind === "ante"
    ? { at: window.anteDeadline, label: "ante deadline" }
    : { at: window.bettingClosedAt, label: "live betting close" };
}

/** Pure: turn a stored wager plus what the chain holds into a list of checks. */
export function evaluateCommitment(
  wager: StoredWager,
  window: WagerWindow,
  landed: LandedCommitment,
): CommitmentCheck[] {
  const expectedMemo = wagerMemo(wager.roundId, wager.id, wager.commitmentHash);
  const checks: CommitmentCheck[] = [];

  checks.push({
    id: "on_chain",
    label: "Transaction is on Devnet and succeeded",
    ok: landed.found && !landed.failed,
    detail: !landed.found
      ? "No transaction with this signature was found on Devnet."
      : landed.failed
        ? `The transaction failed on-chain: ${landed.error ?? "unknown error"}.`
        : `Confirmed in slot ${landed.slot ?? "?"}.`,
  });

  checks.push({
    id: "signer",
    label: "Signed by your wallet",
    ok: landed.signers.includes(wager.walletAddress),
    detail: landed.signers.includes(wager.walletAddress)
      ? `${wager.walletAddress} is a required signer.`
      : `${wager.walletAddress} did not sign this transaction.`,
  });

  const memoFound = landed.memos.includes(expectedMemo);
  checks.push({
    id: "memo",
    label: "Memo records this commitment",
    ok: memoFound,
    detail: memoFound
      ? `Memo: ${expectedMemo}`
      : landed.memos.length === 0
        ? "The transaction carries no memo."
        : `Memo on-chain (${landed.memos.join(" | ")}) does not match ${expectedMemo}.`,
  });

  const leaks = landed.memos.some(
    (memo) => memo.includes(wager.nonce) || memo.includes(wager.modelId),
  );
  checks.push({
    id: "hash_only",
    label: "Memo reveals only the hash",
    ok: landed.memos.length > 0 && !leaks,
    detail: leaks
      ? "The memo contains the pick or the nonce."
      : "Neither the pick nor the nonce appears on-chain.",
  });

  checks.push({
    id: "transfer",
    label: "Treasury received the wagered SOL",
    ok: landed.treasuryDelta === wager.lamports,
    detail: `Treasury balance changed by ${landed.treasuryDelta} lamports; the wager is ${wager.lamports}.`,
  });

  const boundary = wagerBoundary(wager.kind, window);
  let onTime: boolean;
  let timeDetail: string;
  if (!landed.blockTime) {
    onTime = false;
    timeDetail = "The network has not assigned a block time.";
  } else if (boundary.at === null) {
    onTime = true;
    timeDetail = `Landed ${landed.blockTime}; live betting is still open.`;
  } else {
    const limit =
      new Date(boundary.at).getTime() + LANDING_GRACE_SECONDS * 1000;
    onTime = new Date(landed.blockTime).getTime() <= limit;
    timeDetail = `Landed ${landed.blockTime}; ${boundary.label} ${new Date(boundary.at).toISOString()} (+${LANDING_GRACE_SECONDS}s landing window).`;
  }
  checks.push({
    id: "on_time",
    label: `Landed before the ${boundary.label}`,
    ok: onTime,
    detail: timeDetail,
  });

  const recomputed = commitmentHash({
    roundId: wager.roundId,
    wagerId: wager.id,
    modelId: wager.modelId,
    lamports: wager.lamports,
    nonce: wager.nonce,
  });
  checks.push({
    id: "preimage",
    label: "Your pick re-hashes to the committed hash",
    ok: recomputed === wager.commitmentHash,
    detail:
      recomputed === wager.commitmentHash
        ? `sha256 of the disclosed pick and nonce = ${recomputed}.`
        : `Recomputed ${recomputed}, stored ${wager.commitmentHash}.`,
  });

  return checks;
}

/** Read one transaction from Devnet and reduce it to a LandedCommitment. */
export async function readLandedCommitment(
  connection: Connection,
  signature: string,
  treasury: string,
): Promise<LandedCommitment> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta) {
    return {
      found: false,
      failed: false,
      error: null,
      memos: [],
      signers: [],
      treasuryDelta: BigInt(0),
      blockTime: null,
      slot: null,
    };
  }

  const message = tx.transaction.message;
  const keys = message.staticAccountKeys;
  const memos = message.compiledInstructions
    .filter((ix) => keys[ix.programIdIndex]?.equals(MEMO_PROGRAM_ID))
    .map((ix) => Buffer.from(ix.data).toString("utf8"));
  const signers = keys
    .slice(0, message.header.numRequiredSignatures)
    .map((key) => key.toBase58());

  const treasuryKey = new PublicKey(treasury);
  const index = keys.findIndex((key) => key.equals(treasuryKey));
  const treasuryDelta =
    index >= 0
      ? BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index])
      : BigInt(0);

  return {
    found: true,
    failed: tx.meta.err !== null,
    error: tx.meta.err ? JSON.stringify(tx.meta.err) : null,
    memos,
    signers,
    treasuryDelta,
    blockTime: tx.blockTime
      ? new Date(tx.blockTime * 1000).toISOString()
      : null,
    slot: tx.slot,
  };
}

export interface CommitmentVerification {
  wagerId: string;
  roundId: string;
  kind: "ante" | "live";
  status: string;
  signature: string;
  explorerUrl: string;
  memo: string;
  /** The disclosed preimage — returned only to the wager's owner. */
  preimage: {
    roundId: string;
    wagerId: string;
    modelId: string;
    lamports: string;
    nonce: string;
    commitmentHash: string;
  };
  boundary: { at: string | null; label: string; graceSeconds: number };
  blockTime: string | null;
  checks: CommitmentCheck[];
  verified: boolean;
  /** Plain statement of the guarantee's limits, for any UI that shows this. */
  scope: string;
}

export const VERIFICATION_SCOPE =
  "Proves this commitment existed on Solana Devnet before betting closed and was not altered. It does not prove the models, judge or settlement were run honestly; those rest on the backend.";

interface WagerRowForVerify {
  id: string;
  round_id: string;
  user_id: string;
  model_id: string;
  kind: "ante" | "live";
  lamports: number | string;
  wallet_address: string;
  commitment_hash: string;
  commitment_nonce: string;
  status: string;
  signature: string | null;
  rounds:
    | {
        prediction_deadline: string;
        betting_closed_at: string | null;
        treasury_address: string | null;
      }
    | Array<{
        prediction_deadline: string;
        betting_closed_at: string | null;
        treasury_address: string | null;
      }>
    | null;
}

/**
 * Verify one wager end to end. Locate it by id or by transaction signature.
 * Pass `ownerId` to scope the lookup to that account (the API always does);
 * the operator script omits it.
 */
export async function verifyWagerCommitment(input: {
  wagerId?: string;
  signature?: string;
  ownerId?: string;
  connection?: Connection;
}): Promise<CommitmentVerification> {
  if (!input.wagerId && !input.signature) {
    throw new NotFoundError("Name a wager or a signature to verify");
  }
  let query = getServiceRoleSupabase()
    .from("wagers")
    .select(
      "id, round_id, user_id, model_id, kind, lamports, wallet_address, commitment_hash, commitment_nonce, status, signature, rounds(prediction_deadline, betting_closed_at, treasury_address)",
    );
  query = input.wagerId
    ? query.eq("id", input.wagerId)
    : query.eq("signature", input.signature!);
  if (input.ownerId) query = query.eq("user_id", input.ownerId);

  const { data, error } = await query.maybeSingle();
  if (error) throw new InternalError("Failed to read the wager", error);
  const row = data as WagerRowForVerify | null;
  if (!row) throw new NotFoundError("Wager not found");
  if (!row.signature) {
    throw new NotFoundError(
      "This wager was never signed, so nothing is on-chain",
    );
  }

  const round = Array.isArray(row.rounds) ? row.rounds[0] : row.rounds;
  if (!round?.treasury_address) {
    throw new InternalError("The wager's round has no treasury on record");
  }

  const wager: StoredWager = {
    id: row.id,
    roundId: row.round_id,
    modelId: row.model_id,
    kind: row.kind,
    lamports: BigInt(row.lamports),
    walletAddress: row.wallet_address,
    commitmentHash: row.commitment_hash,
    nonce: row.commitment_nonce,
  };
  const window: WagerWindow = {
    anteDeadline: round.prediction_deadline,
    bettingClosedAt: round.betting_closed_at,
  };

  const connection = input.connection ?? (await getDevnetConnection());
  const landed = await readLandedCommitment(
    connection,
    row.signature,
    round.treasury_address,
  );
  const checks = evaluateCommitment(wager, window, landed);
  const boundary = wagerBoundary(wager.kind, window);

  return {
    wagerId: wager.id,
    roundId: wager.roundId,
    kind: wager.kind,
    status: row.status,
    signature: row.signature,
    explorerUrl: explorerTxUrl(row.signature),
    memo: wagerMemo(wager.roundId, wager.id, wager.commitmentHash),
    preimage: {
      roundId: wager.roundId,
      wagerId: wager.id,
      modelId: wager.modelId,
      lamports: wager.lamports.toString(),
      nonce: wager.nonce,
      commitmentHash: wager.commitmentHash,
    },
    boundary: { ...boundary, graceSeconds: LANDING_GRACE_SECONDS },
    blockTime: landed.blockTime,
    checks,
    verified: checks.every((check) => check.ok),
    scope: VERIFICATION_SCOPE,
  };
}
