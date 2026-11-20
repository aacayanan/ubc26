/**
 * F23 — what the blockchain proves, in plain language.
 *
 * This is the ONLY copy of the guarantee text on the site. It mirrors the
 * "Plain-language summary" in docs/solana-integration.md, which is the source
 * of truth; change the doc first, then this file, and never restate a
 * guarantee in a page's own words. Every surface that makes a claim about
 * the chain (the What's on-chain page, the landing page, the record panels)
 * renders from here.
 *
 * Plain words on purpose: a reader should not need to know what a hash, a
 * memo or Devnet is to understand what they can and cannot rely on.
 */

export interface Guarantee {
  title: string;
  body: string;
}

/** What anyone can check on Solana Devnet. */
export const CHAIN_PROVES: readonly Guarantee[] = [
  {
    title: "Your prediction was locked in on time.",
    body: "Each prediction is one transaction that sends your Devnet SOL to the pool and records a scrambled fingerprint of your pick. The network stamps the time, and nobody can edit it afterwards. Use “Verify on Devnet” on My predictions to check it yourself.",
  },
  {
    title: "Your pick was not swapped later.",
    body: "Only the fingerprint is public, so nobody sees your pick. When you reveal your pick and its secret, anyone can recompute the fingerprint and see that it matches.",
  },
  {
    title: "The round's deadline was announced up front.",
    body: "When a round opens, its ID, ante deadline and betting rules are recorded. Each round page checks that record against the round.",
  },
  {
    title: "When betting closed, and what the result was.",
    body: "The moment betting closed and why, and the settlement: who was paid, the 5% fee, or why everyone was refunded. The results page checks the settlement against the round's result.",
  },
  {
    title: "Payouts and refunds really happened.",
    body: "Winnings and refunds are ordinary transfers that anyone can look up.",
  },
];

/** What the chain cannot see — these rest on trusting Zelto. */
export const CHAIN_DOES_NOT_PROVE: readonly Guarantee[] = [
  {
    title: "That the models and the judge were honest.",
    body: "Running the AI models and judging their renders happens on our servers. The chain cannot see it.",
  },
  {
    title: "That betting closed by the stated rule.",
    body: "Our server and database enforce the deadline and the 75% cutoff. The chain only timestamps what we did.",
  },
  {
    title: "That the pool is held safely.",
    body: "Wagered SOL sits in a wallet we control (the treasury), not in a smart contract.",
  },
  {
    title: "That the split was calculated correctly.",
    body: "The round, close and settlement records are our own statements, signed by our operator wallet. They prove when we said something, not that it was right.",
  },
];

/** The limits that apply to everything above. */
export const CHAIN_LIMITS: readonly string[] = [
  "Solana Devnet only. Devnet SOL is test currency with no value, and no real money is ever involved.",
  "Devnet can be reset, so these records are demo-grade, not a permanent ledger.",
];

/** Who needs a wallet, and for what. */
export const WALLET_BOUNDARY =
  "You never need a wallet to browse rounds, watch the renders or vote. A Phantom wallet is needed only to make predictions, because you sign your own prediction.";

/** One sentence for tight spaces (panels, footers). */
export const CHAIN_ONE_LINER =
  "Solana Devnet proves your prediction was locked in on time and not changed. It does not prove the models or the judge were honest.";
