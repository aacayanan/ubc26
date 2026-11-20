**G1 decided 2026-11-19** — the scope is lightweight SPL Memo transactions on Solana Devnet.

- **Stake commitments are user-signed.** The user's wallet signs the memo; the server pays the fee and submits. That makes the claim "this keypair committed before the deadline" rather than "the operator posted a hash on the user's behalf". Binding that keypair to an account is F20's `wallets.verified_at` step.
- **Round/deadline and settlement records are operator-signed**, because the operator genuinely owns those actions.
- **No custom program.** A transaction's network-assigned `blockTime` plus immutability gives the property the product sells; an Anchor program is the documented upgrade path, not a prerequisite.
- **Memos carry the commitment hash only** — never the pick, never the nonce.

What this does _not_ prove: that models ran honestly, that the judge was impartial, or that a commitment backed a stake that actually counted in the pool. Devnet is disposable, so these are demo-grade guarantees.

Two prerequisites are now recorded on F20: a Sign-in-with-Solana account gets no `wallets` row (so `funded` is false and staking is refused today), and `predictions.commitment_hash` is not frozen outside `OPEN`.

Full record, including the tradeoffs and the guarantee ladder: `docs/solana-integration.md`. F20–F23 have been rewritten to match this scope.
