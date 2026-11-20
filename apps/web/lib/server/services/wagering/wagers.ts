import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";
import {
  AuthorizationError,
  ConflictError,
  InternalError,
  NotFoundError,
  ValidationError,
} from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getDevnetConnection } from "@/lib/server/integrations/solana/connection";
import {
  explorerTxUrl,
  getOperatorKeypair,
} from "@/lib/server/integrations/solana/config";
import {
  buildWagerTransaction,
  coSignVerifiedWager,
  confirmSignature,
  parsePublicKey,
  verifyLandedWager,
} from "@/lib/server/integrations/solana/transactions";
import { commitmentHash, newNonce, wagerMemo } from "./commitment";
import {
  quoteAnte,
  quoteLiveMinimum,
  type LiveMinimumQuote,
  type SolUsdQuote,
} from "./quote";
import { WAGER_LIMITS } from "./limits";

/**
 * SOL wagers (F20 + F10, Devnet prototype).
 *
 *   prepare  -> server builds transfer+memo, operator as fee payer; row `prepared`
 *   (wallet) -> Phantom signTransaction (sign only, never send)
 *   submit   -> bytes checked, window re-checked under the round lock
 *               (`wager_reserve`), operator co-signs, server broadcasts
 *   confirm  -> chain re-read and verified; row `accepted` / `rejected` / `expired`
 *
 * A wager counts only when `accepted`. Signing, or even broadcasting, is not
 * acceptance.
 */

export type WagerKind = "ante" | "live";

interface RoundRow {
  id: string;
  status: string;
  wagering_mode: string;
  betting_phase: string;
  prediction_deadline: string;
  treasury_address: string | null;
  ante_usd_cents: number;
}

export interface WagerRow {
  id: string;
  round_id: string;
  user_id: string;
  model_id: string;
  wallet_address: string;
  kind: WagerKind;
  lamports: string | number;
  status: string;
  message_b64: string;
  signature: string | null;
  last_valid_block_height: number | string | null;
  prepared_expires_at: string;
}

function admin(): SupabaseClient {
  return getServiceRoleSupabase();
}

/**
 * The wallet this account wagers from.
 *
 * Email accounts link one (`wallets` row). A Sign-in-with-Solana account has a
 * `web3` identity but, before this, no `wallets` row — which left Phantom-only
 * accounts unable to wager. Bridge it here: the identity's address becomes the
 * account's wallet row (still unverified until a signed transfer confirms).
 */
export async function resolveWagerWallet(user: User): Promise<string | null> {
  const supabase = admin();
  const { data, error } = await supabase
    .from("wallets")
    .select("address")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw new InternalError("Failed to read the linked wallet", error);
  if (data?.address) return data.address as string;

  const address = web3IdentityAddress(user);
  if (!address) return null;

  const { error: insertError } = await supabase
    .from("wallets")
    .insert({ user_id: user.id, address, cluster: "devnet" });
  if (insertError && insertError.code !== "23505") {
    throw new InternalError(
      "Failed to record the Solana sign-in wallet",
      insertError,
    );
  }
  return address;
}

function web3IdentityAddress(user: User): string | null {
  for (const identity of user.identities ?? []) {
    if (identity.provider !== "web3" && identity.provider !== "solana")
      continue;
    const data = (identity.identity_data ?? {}) as Record<string, unknown>;
    const candidates = [
      data.address,
      data.wallet_address,
      typeof data.sub === "string" ? data.sub.split(":").pop() : undefined,
      typeof identity.id === "string"
        ? identity.id.split(":").pop()
        : undefined,
    ];
    for (const candidate of candidates) {
      if (
        typeof candidate === "string" &&
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(candidate)
      ) {
        return candidate;
      }
    }
  }
  return null;
}

async function loadRound(roundId: string): Promise<RoundRow> {
  const { data, error } = await admin()
    .from("rounds")
    .select(
      "id, status, wagering_mode, betting_phase, prediction_deadline, treasury_address, ante_usd_cents",
    )
    .eq("id", roundId)
    .maybeSingle();
  if (error) throw new InternalError("Failed to read the round", error);
  if (!data) throw new NotFoundError("Round not found");
  return data as RoundRow;
}

export interface PreparedWager {
  wagerId: string;
  kind: WagerKind;
  modelId: string;
  lamports: string;
  /** base64 unsigned transaction for Phantom's signTransaction. */
  transaction: string;
  memo: string;
  expiresAt: string;
  quote: SolUsdQuote | null;
}

export async function prepareWager(input: {
  user: User;
  roundId: string;
  modelId: string;
  kind: WagerKind;
  /** Live wagers only; antes are priced by quote. */
  lamports?: bigint;
  /** The address Phantom reports as connected. */
  connectedWallet: string;
}): Promise<PreparedWager> {
  const { user, roundId, modelId, kind } = input;
  const supabase = admin();
  const round = await loadRound(roundId);

  if (round.wagering_mode !== "devnet_sol" || !round.treasury_address) {
    throw new ConflictError("This round does not take SOL wagers");
  }

  // Fast pre-checks. The authoritative check is `wager_reserve` at submit time.
  if (kind === "ante") {
    if (
      round.status !== "OPEN" ||
      round.betting_phase !== "ante" ||
      Date.now() > Date.parse(round.prediction_deadline)
    ) {
      throw new ConflictError("The ante window for this round has closed");
    }
  } else if (round.status !== "RUNNING" || round.betting_phase !== "live") {
    throw new ConflictError("Live betting is not open for this round");
  }

  const { data: participant } = await supabase
    .from("round_models")
    .select("model_id")
    .eq("round_id", roundId)
    .eq("model_id", modelId)
    .maybeSingle();
  if (!participant)
    throw new ValidationError("That model is not in this round");

  const { data: profile } = await supabase
    .from("users")
    .select("role, practice_mode")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.role === "admin")
    throw new AuthorizationError("Staff accounts cannot wager");
  if (profile?.practice_mode) {
    throw new AuthorizationError(
      "Practice mode accounts can watch and vote but not wager",
    );
  }

  const linked = await resolveWagerWallet(user);
  if (!linked) throw new AuthorizationError("Link a Solana wallet to wager");
  if (linked !== input.connectedWallet) {
    throw new ValidationError(
      "Connect the wallet linked to your account in Phantom before wagering",
    );
  }
  const userKey = parsePublicKey(linked, "Your linked wallet");

  // Spam guard: a handful of unsigned prepares per minute at most.
  const { count: recent } = await supabase
    .from("wagers")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("status", "prepared")
    .gte("created_at", new Date(Date.now() - 60_000).toISOString());
  if ((recent ?? 0) >= WAGER_LIMITS.maxPreparedPerMinute) {
    throw new ConflictError("Too many unsigned wagers; sign or wait a minute");
  }

  let lamports: bigint;
  let quote: SolUsdQuote | null = null;
  // Stored with the wager as evidence of how its amount was priced.
  let storedQuote: SolUsdQuote | LiveMinimumQuote | null = null;
  if (kind === "ante") {
    quote = await quoteAnte(round.ante_usd_cents);
    storedQuote = quote;
    lamports = BigInt(quote.lamports);
  } else {
    lamports = input.lamports ?? BigInt(0);
    const minimum = await quoteLiveMinimum(WAGER_LIMITS.minLiveUsdCents);
    storedQuote = minimum;
    if (lamports < BigInt(minimum.minLamports)) {
      const minSol = Number(minimum.minLamports) / 1_000_000_000;
      throw new ValidationError(
        `The minimum bet after the ante is $${(WAGER_LIMITS.minLiveUsdCents / 100).toFixed(2)} in SOL (about ${minSol.toFixed(4)} SOL right now)`,
      );
    }
  }

  const wagerId = randomUUID();
  const nonce = newNonce();
  const hash = commitmentHash({ roundId, wagerId, modelId, lamports, nonce });
  const memo = wagerMemo(roundId, wagerId, hash);

  // Verify the RPC is Devnet before reserving the wager or signing anything.
  const connection = await getDevnetConnection();
  const operator = getOperatorKeypair();
  const prepared = await buildWagerTransaction({
    connection,
    operator: operator.publicKey,
    user: userKey,
    treasury: new PublicKey(round.treasury_address),
    lamports,
    memo,
  });

  // A blockhash lives ~60-90 s; the prepared wager lives slightly less.
  const expiresAt = new Date(Date.now() + 55_000).toISOString();

  const { error } = await supabase.from("wagers").insert({
    id: wagerId,
    round_id: roundId,
    user_id: user.id,
    model_id: modelId,
    wallet_address: linked,
    kind,
    lamports: lamports.toString(),
    commitment_hash: hash,
    commitment_nonce: nonce,
    message_b64: prepared.messageB64,
    prepared_expires_at: expiresAt,
    last_valid_block_height: prepared.lastValidBlockHeight,
    quote: storedQuote,
  });
  if (error)
    throw new InternalError("Failed to record the prepared wager", error);

  return {
    wagerId,
    kind,
    modelId,
    lamports: lamports.toString(),
    transaction: prepared.transactionB64,
    memo,
    expiresAt,
    quote,
  };
}

export interface WagerResult {
  wagerId: string;
  status: "accepted" | "rejected" | "expired" | "submitted";
  signature: string | null;
  explorerUrl: string | null;
  reason: string | null;
}

export async function submitWager(input: {
  userId: string;
  wagerId: string;
  signedTransaction: string;
}): Promise<WagerResult> {
  const supabase = admin();
  const { data, error } = await supabase
    .from("wagers")
    .select("*")
    .eq("id", input.wagerId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) throw new InternalError("Failed to read the wager", error);
  if (!data) throw new NotFoundError("Wager not found");
  const wager = data as WagerRow;

  if (wager.status !== "prepared") {
    return toResult(
      wager,
      wager.status === "submitted"
        ? "submitted"
        : (wager.status as WagerResult["status"]),
      null,
    );
  }

  // Verify the RPC is Devnet before reserving the wager or signing anything.
  const connection = await getDevnetConnection();
  const operator = getOperatorKeypair();
  const { signature, raw } = coSignVerifiedWager({
    signedB64: input.signedTransaction,
    preparedMessageB64: wager.message_b64,
    user: new PublicKey(wager.wallet_address),
    operator,
  });

  const lastValid = Number(wager.last_valid_block_height);

  // The authoritative window check. Nothing is broadcast unless it passes.
  const { error: reserveError } = await supabase.rpc("wager_reserve", {
    p_wager_id: wager.id,
    p_signature: signature,
    p_last_valid_block_height: lastValid,
  });
  if (reserveError) throw mapReserveError(reserveError);

  try {
    await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 0,
    });
  } catch (sendError) {
    const message =
      sendError instanceof Error ? sendError.message : String(sendError);
    // A preflight (simulation) failure means the cluster refused it: nothing
    // landed. Anything else may have been forwarded — leave it for confirm.
    if (
      /simulation failed|insufficient|custom program error|blockhash not found|0x1\b/i.test(
        message,
      )
    ) {
      await resolve(wager.id, "rejected", {
        reason: friendlySendError(message),
      });
      return {
        wagerId: wager.id,
        status: "rejected",
        signature,
        explorerUrl: null,
        reason: friendlySendError(message),
      };
    }
    logger.warn("wager.send.uncertain", {
      wagerId: wager.id,
      error: message.slice(0, 200),
    });
  }

  return settleSubmitted(
    {
      ...wager,
      signature,
      last_valid_block_height: lastValid,
      status: "submitted",
    },
    raw,
  );
}

/** Confirm a submitted wager against the chain and record the outcome. */
export async function settleSubmitted(
  wager: WagerRow,
  raw?: Buffer,
  timeoutMs?: number,
): Promise<WagerResult> {
  if (!wager.signature)
    throw new InternalError("A submitted wager has no signature");
  const connection = await getDevnetConnection();
  const outcome = await confirmSignature({
    connection,
    signature: wager.signature,
    lastValidBlockHeight: Number(wager.last_valid_block_height),
    raw,
    timeoutMs,
  });

  if (outcome.kind === "pending") {
    return toResult(wager, "submitted", "Still confirming on Devnet");
  }
  if (outcome.kind === "expired") {
    await resolve(wager.id, "expired", {
      reason: "the transaction expired before it landed; no SOL moved",
    });
    return toResult(
      wager,
      "expired",
      "The transaction expired before it landed; no SOL moved",
    );
  }
  if (outcome.failed) {
    await resolve(wager.id, "rejected", {
      slot: outcome.slot,
      reason: `transaction failed on-chain: ${outcome.error}`,
    });
    return toResult(
      wager,
      "rejected",
      "The transaction failed on-chain; no SOL moved",
    );
  }

  const round = await loadRound(wager.round_id);
  const landed = await verifyLandedWager({
    connection,
    signature: wager.signature,
    preparedMessageB64: wager.message_b64,
    treasury: new PublicKey(round.treasury_address!),
    lamports: BigInt(wager.lamports),
  });

  if (!landed.ok) {
    if (landed.reason === "transaction temporarily unavailable") {
      return toResult(
        wager,
        "submitted",
        "The confirmed transaction is not readable yet",
      );
    }
    // Funds may have moved; if so they are queued for refund, never kept.
    await resolve(wager.id, "rejected", {
      slot: landed.slot,
      blockTime: landed.blockTime,
      reason: landed.reason ?? "verification failed",
      fundsLanded: landed.treasuryDelta > BigInt(0),
    });
    return toResult(
      wager,
      "rejected",
      "The landed transaction did not verify; any SOL received will be refunded",
    );
  }

  await resolve(wager.id, "accepted", {
    slot: landed.slot,
    blockTime: landed.blockTime,
  });
  logger.info("wager.accepted", {
    wagerId: wager.id,
    roundId: wager.round_id,
    kind: wager.kind,
  });
  return toResult(wager, "accepted", null);
}

/** Resolve every wager still `submitted` (job + pre-settlement). */
export async function reconcileSubmittedWagers(
  roundId?: string,
): Promise<{ resolved: number; pending: number }> {
  let query = admin().from("wagers").select("*").eq("status", "submitted");
  if (roundId) query = query.eq("round_id", roundId);
  const { data, error } = await query.limit(50);
  if (error) throw new InternalError("Failed to list submitted wagers", error);

  let resolved = 0;
  let pending = 0;
  for (const row of (data ?? []) as WagerRow[]) {
    const result = await settleSubmitted(row, undefined, 3_000);
    if (result.status === "submitted") pending += 1;
    else resolved += 1;
  }
  return { resolved, pending };
}

async function resolve(
  wagerId: string,
  outcome: "accepted" | "rejected" | "expired",
  detail: {
    slot?: number;
    blockTime?: string | null;
    reason?: string;
    fundsLanded?: boolean;
  },
): Promise<void> {
  const { error } = await admin().rpc("wager_resolve", {
    p_wager_id: wagerId,
    p_outcome: outcome,
    p_slot: detail.slot ?? null,
    p_block_time: detail.blockTime ?? null,
    p_reason: detail.reason ?? null,
    p_funds_landed: detail.fundsLanded ?? false,
  });
  if (error)
    throw new InternalError("Failed to record the wager outcome", error);
}

function toResult(
  wager: WagerRow,
  status: WagerResult["status"],
  reason: string | null,
): WagerResult {
  return {
    wagerId: wager.id,
    status,
    signature: wager.signature,
    explorerUrl:
      wager.signature && status !== "expired"
        ? explorerTxUrl(wager.signature)
        : null,
    reason,
  };
}

function friendlySendError(message: string): string {
  if (/insufficient|0x1\b/i.test(message)) {
    return "Your wallet does not have enough Devnet SOL for this wager";
  }
  return "Devnet refused the transaction during simulation; no SOL moved";
}

function mapReserveError(error: { code?: string; message?: string }): Error {
  const message = error.message ?? "The wager could not be accepted";
  switch (error.code) {
    case "P0001":
    case "23505":
      return new ConflictError(message);
    case "22023":
      return new ValidationError(message);
    case "42501":
      return new AuthorizationError(message);
    default:
      return new InternalError("The wager could not be reserved", { error });
  }
}

export interface UserWagerView {
  id: string;
  kind: WagerKind;
  modelId: string;
  lamports: string;
  status: string;
  signature: string | null;
  explorerUrl: string | null;
  createdAt: string;
  rejectionReason: string | null;
  settlementOutcome: string | null;
  payoutLamports: string | null;
  commitmentHash: string;
}

export async function listUserWagers(
  userId: string,
  roundId: string,
): Promise<UserWagerView[]> {
  const { data, error } = await admin()
    .from("wagers")
    .select(
      "id, kind, model_id, lamports, status, signature, created_at, rejection_reason, settlement_outcome, payout_lamports, commitment_hash",
    )
    .eq("user_id", userId)
    .eq("round_id", roundId)
    .neq("status", "prepared")
    .order("created_at", { ascending: true });
  if (error) throw new InternalError("Failed to read your wagers", error);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    kind: row.kind as WagerKind,
    modelId: row.model_id as string,
    lamports: String(row.lamports),
    status: row.status as string,
    signature: (row.signature as string | null) ?? null,
    explorerUrl:
      row.signature && row.status !== "expired"
        ? explorerTxUrl(row.signature as string)
        : null,
    createdAt: row.created_at as string,
    rejectionReason: (row.rejection_reason as string | null) ?? null,
    settlementOutcome: (row.settlement_outcome as string | null) ?? null,
    payoutLamports:
      row.payout_lamports === null ? null : String(row.payout_lamports),
    commitmentHash: row.commitment_hash as string,
  }));
}
