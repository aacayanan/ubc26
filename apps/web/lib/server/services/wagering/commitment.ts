import "server-only";

import { createHash, randomBytes } from "node:crypto";

/**
 * Wager commitments (F20, SOL prototype).
 *
 * The memo carries a hash of the pick, never the pick: the transfer amount and
 * the treasury are public on-chain anyway, but which model a wallet backed is
 * not published until the owner discloses the preimage.
 *
 *   commitment = sha256("aisd:v2|" + roundId | wagerId | modelId | lamports | nonce)
 *   memo       = "aisd:v2:wager:<roundId>:<wagerId>:<commitment>"
 */

export const MEMO_VERSION = "aisd:v2";

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function commitmentHash(input: {
  roundId: string;
  wagerId: string;
  modelId: string;
  lamports: bigint;
  nonce: string;
}): string {
  return createHash("sha256")
    .update(
      [
        MEMO_VERSION,
        input.roundId,
        input.wagerId,
        input.modelId,
        input.lamports.toString(),
        input.nonce,
      ].join("|"),
    )
    .digest("hex");
}

export function wagerMemo(
  roundId: string,
  wagerId: string,
  hash: string,
): string {
  return `${MEMO_VERSION}:wager:${roundId}:${wagerId}:${hash}`;
}

export function roundMemo(input: {
  roundId: string;
  anteDeadline: string;
  budgetTokens: number;
  cutoffBps: number;
  feeBps: number;
  treasury: string;
}): string {
  return [
    `${MEMO_VERSION}:round`,
    input.roundId,
    new Date(input.anteDeadline).toISOString(),
    input.budgetTokens,
    input.cutoffBps,
    input.feeBps,
    input.treasury,
  ].join(":");
}

export function closeMemo(input: {
  roundId: string;
  reason: string;
  closedAt: string;
  snapshotHash: string;
}): string {
  return `${MEMO_VERSION}:close:${input.roundId}:${input.reason}:${new Date(input.closedAt).toISOString()}:${input.snapshotHash}`;
}

export function settleMemo(input: {
  roundId: string;
  kind: string;
  winners: string[];
  gross: string;
  fee: string;
  net: string;
  payoutCount: number;
}): string {
  const winners = input.winners.length > 0 ? input.winners.join(",") : "none";
  return `${MEMO_VERSION}:settle:${input.roundId}:${input.kind}:${winners}:${input.gross}:${input.fee}:${input.net}:${input.payoutCount}`;
}

export function payoutMemo(
  roundId: string,
  payoutId: string,
  kind: string,
): string {
  return `${MEMO_VERSION}:${kind === "refund" ? "refund" : "payout"}:${roundId}:${payoutId}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
