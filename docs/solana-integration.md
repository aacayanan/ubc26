# Solana integration scope

> **2026-11-20 — product pivot: SOL-backed live parimutuel wagering (Devnet only).**
> The section below, _SOL wagering prototype_, is the current shape. The G1
> record after it (hash-only points commitments) is kept as history; where they
> disagree, the 2026-11-20 section wins.

## SOL wagering prototype (2026-11-20)

**Devnet only, valueless test SOL.** Mainnet transfers and real-money wagering
stay disabled until a documented legal review and an independent security
review are complete. The code cannot reach Mainnet: every signing path first
checks the RPC's genesis hash against Devnet's
(`apps/web/lib/server/integrations/solana/connection.ts`), and RPC URLs naming
mainnet or testnet are refused outright.

### What a wager is

One Solana transaction, so the money and the commitment are atomic:

| Instruction        | Content                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| Compute-unit price | a tiny priority fee                                                         |
| System transfer    | user wallet → round treasury, the wager amount in lamports                  |
| Memo v2            | `aisd:v2:wager:<roundId>:<wagerId>:<commitment>`, the user listed as signer |

`commitment = sha256("aisd:v2|roundId|wagerId|modelId|lamports|nonce")` — the
memo never carries the pick or the nonce. The **operator** is the fee payer and
therefore a **required signer**: the user signs with Phantom (sign only, never
send), the server checks the signed bytes are exactly what it prepared,
re-checks the betting window under the round row lock (`wager_reserve`), and
only then co-signs and broadcasts. A wallet cannot broadcast a valid wager on its
own, so a late wager is refused before any SOL moves.

A wager counts only when it is **accepted**: the server re-reads the confirmed
transaction from Devnet, checks the message bytes match the prepared ones, that
it did not fail, and that the treasury balance grew by exactly the wager amount.
Signing in Phantom, or even broadcasting, is not acceptance.

### The windows

1. **Ante** — `OPEN` until `prediction_deadline` (now the ante deadline). A
   $5-equivalent ante, priced from the SOL/USD spot price at prepare time
   (recorded with the wager as evidence; the lamport amount is authoritative).
   One accepted ante per account per round. The ante is the first wager and the
   ticket to live betting.
2. **Live** — while the models generate (`RUNNING`, `betting_phase = live`).
   Eligible accounts place more wagers on any model. Estimated multipliers move
   with accepted wagers only.
3. **Closed** — betting closes the moment the **first** model reaches 75% of its
   output-token budget, or earlier if a model finishes or fails. The pipeline
   checks each chunk **before** it is stored or previewed, so the close commits
   before any output past the threshold is visible. An optional per-round stall
   safeguard closes betting if generation stops producing chunks. Final renders,
   gate results, judge verdicts and crowd votes are refused by the database until
   betting is closed.

A wager co-signed inside the window may confirm a few seconds after the close
(bounded by its blockhash lifetime, ~60–90 s). It counts; the pool is finalized
only once no wager is still confirming.

### Settlement and payouts

- Fee: `fee_bps` fixed per round at creation (default 5%), charged **only** on
  rounds that pay winners.
- Split: the net pool goes to backers of every model that conformed. One
  conformer takes it all; several split it by **dead heat** (equal parts per
  winning model, pro-rata within each). The crowd vote never moves SOL.
- Full refund, no fee, when the round is void or cancelled, nobody conformed, or
  nobody backed a winner.
- Exact integer lamports, largest-remainder rounding: payouts + fee = gross pool,
  to the lamport.
- Payouts are a durable queue. A payout's signature and expiry are stored before
  it is broadcast; an unclear payout is only rebuilt once the old signature is
  provably dead, so it cannot be paid twice. If the treasury cannot cover a
  round, the round's payouts are put on hold — nobody is paid partially.

### Commitments and verification (F20, as shipped)

F20 shipped against the wager shape above, not the `aisd:v1:stake` /
`place_stake` sequence in the G1 record below (points stakes are retired). How
each F20 requirement is met:

| Requirement                    | Where it lives                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A Phantom account can wager    | `20261120000600_siws_wallet_on_signup.sql` writes the `wallets` row at signup (and backfilled); `resolveWagerWallet` keeps a lazy bridge as a fallback |
| User-signed, operator-paid     | `buildWagerTransaction` / `coSignVerifiedWager` (`lib/server/integrations/solana/transactions.ts`)                                                     |
| Memo carries the hash only     | `aisd:v2:wager:<roundId>:<wagerId>:<commitment>`; the nonce lives in `wagers.commitment_nonce` (owner-readable via the verify endpoint only)           |
| One wager, one transaction     | every ante or live wager is its own prepared transaction, hash and memo                                                                                |
| Status persisted and visible   | `wagers.status` prepared → submitted → accepted / rejected / expired, shown in the round's wager panel; a declined signature writes nothing            |
| Commitment immutable           | `20261120000700_freeze_wager_commitments.sql`: commitment + preimage columns frozen from insert; signature and settlement write-once                   |
| Wallet ownership proof         | `wager_resolve` sets `wallets.verified_at` when a wager from that address is accepted                                                                  |
| Devnet only                    | genesis-hash check on every connection (`connection.ts`)                                                                                               |
| `TxPurpose` mirror             | `TX_PURPOSES` / `TxPurpose` in `packages/shared/src/index.ts`                                                                                          |
| Verify on demand, as the owner | `GET /api/wagers/[id]/verify` (owner-scoped) and the **Verify on Devnet** button on My predictions and the round's wager list                          |
| Demonstrable verification      | `scripts/verify-commitment.mjs --signature <sig>` (or `--wager <id>`); same checks, exits non-zero on any failure                                      |

**The checks** (`lib/server/services/wagering/verify.ts`, shared by the
endpoint, the panel and the script), each re-derived from Devnet on every call:

1. the transaction exists on Devnet and did not fail;
2. the account's wallet is a required signer;
3. the memo is exactly `aisd:v2:wager:<roundId>:<wagerId>:<stored hash>`;
4. the memo contains neither the pick (model id) nor the nonce;
5. the treasury's balance changed by exactly the wagered lamports;
6. the block time beats the wager's boundary — the ante deadline for an ante,
   `betting_closed_at` for a live wager — plus a 120 s landing window;
7. the disclosed preimage re-hashes to the stored, memo-carried hash.

**Why the landing window keeps pre-flight and verification consistent.** The
server reserves a wager under the round lock only while its window is open
(`wager_reserve`: ante while `now() <= prediction_deadline`, live while
`betting_phase = 'live'`). Reservation happens before broadcast, and the
transaction's blockhash was fetched before reservation and expires about 150
blocks (~60–90 s) later. So any wager that passed reservation either lands by
`boundary + 120 s` or never lands. Verification checks exactly that bound, so a
wager cannot pass the server's check and then fail verification. The 120 s also
absorbs the validator-estimated skew in `blockTime`.

**Run it** (operator/demo tool; it reads the stored preimage with the service
role, and signs and writes nothing):

```sh
cd apps/web
npx tsx --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json \
  ../../scripts/verify-commitment.mjs --signature <tx signature>
```

**Scope.** A pass proves the commitment existed on Devnet inside its window and
was not altered. It does **not** prove that the models, the judge or settlement
were run honestly; every verification surface says so.

### Round, close and settlement records (F21 / F22, as shipped)

Three operator-signed memos per round, one per idempotency key, stored in
`blockchain_transactions` with `round_id` set:

| Record         | Memo                                                                                             | Key                |
| -------------- | ------------------------------------------------------------------------------------------------ | ------------------ |
| Round opened   | `aisd:v2:round:<roundId>:<ante deadline, ISO-8601 UTC>:<budget>:<cutoffBps>:<feeBps>:<treasury>` | `round:<roundId>`  |
| Betting closed | `aisd:v2:close:<roundId>:<reason>:<closed at, UTC>:<snapshot hash>`                              | `close:<roundId>`  |
| Settled        | `aisd:v2:settle:<roundId>:<kind>:<reason>:<winners>:<gross>:<fee>:<net>:<payout count>`          | `settle:<roundId>` |

- **Correlation and exactness.** Each memo names its round. The round memo's
  deadline is the same instant as `rounds.prediction_deadline`, in UTC.
- **A void is recorded as a void.** A refund names its reason: `voided`,
  `no_winner` or `winner_unbacked`. Settlement memos are summary facts only;
  per-user amounts stay off-chain.
- **Never duplicated, never lost.** A retry re-sends the memo text fixed by the
  first attempt. It replaces a transaction only once the previous one provably
  can no longer land (`chain-records.ts`). The internal job
  `POST /api/internal/jobs/sol {"action":"chain-records"}` does three things:
  - records the round memo for open rounds that have none, only while the ante
    deadline is still ahead
  - records the settlement memo for settled rounds that have none
  - retries anything that is not confirmed
- **Visible and checkable.** The round and results pages show an
  **On-chain record** panel; `pending` / `timeout` / `failed` are never shown as
  confirmed. `GET /api/rounds/[id]/records?check=1` reads each transaction back
  from Devnet and checks:
  - the memo is on-chain and operator-signed
  - it matches the round row
  - for a settlement, the stored settlement agrees with `round_outcomes` and the
    conformance results (`round-records.ts`)

### Plain-language summary (site copy)

This is the user- and judge-facing version of the table below. The site renders
it from `apps/web/lib/chain-guarantees.ts` on the **What's on-chain** page
(`/on-chain`), linked from the footer, the landing page and every record panel.
Change this section first, then that file. Never restate a guarantee in a page's
own words.

**What anyone can check:**

- Your prediction was locked in on time, and your pick was not swapped later.
  Each prediction is one transaction carrying your SOL and a fingerprint (hash)
  of your pick.
- The round's ID, deadline and rules were announced up front.
- When betting closed and why, and the result: who was paid, the 5% fee, or why
  everyone was refunded.
- Payouts and refunds really happened.

**What you still trust AI Showdown for:**

- That the models and the judge were honest.
- That betting closed by the stated rule. The server enforces it; the chain only
  timestamps it.
- That the treasury holds the pool safely. It is an operator wallet, not a smart
  contract.
- That the split was calculated correctly. The operator records prove when the
  operator said something, not that it was right.

**Limits:**

- Devnet only, with valueless test SOL; no real money.
- Devnet can be reset, so these are demo-grade records, not a permanent ledger.

**Who needs a wallet:** nobody, to browse, watch or vote. A Phantom wallet is
needed only to make predictions, because the backer signs their own commitment.
No blockchain knowledge is required; a signature prompt is.

### What the chain proves — and what it does not

| Claim                                                                          | Who guarantees it                                                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| This wallet paid X lamports to the treasury with this commitment, at this slot | **Chain** (transaction, signatures, balances)                                                 |
| The transfer and the commitment happened together                              | **Chain** (one atomic transaction)                                                            |
| The round, its ante deadline and rules were announced                          | Operator memo (`aisd:v2:round:…`), checked against the round row — operator attestation       |
| When and why betting closed                                                    | Operator memo (`aisd:v2:close:…`) — operator attestation                                      |
| The settlement result (kind, reason, winners, gross, fee, net, payout count)   | Operator memo (`aisd:v2:settle:…`), checked against the outcome — a **record**, not a payment |
| A winner was actually paid                                                     | **Chain** — the payout transfer, shown separately from the record                             |
| The deadlines were enforced                                                    | **Backend + database** (locked rows, co-signature); the chain only timestamps                 |
| The models ran honestly and the judge was impartial                            | **Trusted backend** — not verifiable on-chain                                                 |
| The funds are held safely                                                      | **Trusted operator** — the treasury is an operator key, not a program                         |

**What users must trust AI Showdown to do:** run the models and the judge
honestly; close betting by the stated rule and never co-sign after it; hold the
pooled SOL in the treasury and not spend or lose it; send every payout and
refund; compute the split correctly. Memo provides no escrow and enforces no
payout. An Anchor escrow program (funds in program-owned accounts, user-claimed
payouts, timeout refunds) is the custody upgrade that any real-value version
would need — it would still not remove trust in the judge.

**Devnet limits:** test SOL has no value; Devnet can be reset and history wiped;
the public RPC rate-limits (use a dedicated Devnet RPC for the demo); the RPC
airdrop is closed, so wallets are funded from https://faucet.solana.com.

**Mainnet requires**, at minimum: gambling/wagering licensing review for every
served jurisdiction, money-services / KYC / AML / sanctions obligations for a
custodial operator, age and geographic restrictions, responsible-gambling
controls, custody via HSM/MPC rather than an environment variable, and an
independent security review (and audit, if a program is used). Devnet success
proves the mechanics work; it does not show that handling real money is safe or
legal.

---

# G1 record (2026-11-19, historical)

> **F20 shipped against the SOL wager shape** — see _Commitments and
> verification (F20, as shipped)_ above. The `aisd:v1:stake` memo, the
> `place_stake` sequence and the `predictions.commitment_hash` freeze below
> describe the retired points path and are kept as history.

**Decided 2026-11-19.** This record settles the one gated row in the
[decisions log](../REQUIREMENTS.md#decisions-log): what the chain is used for,
who signs, and — most importantly — **what a verification actually proves**. F20,
F21, F22 and F23 are written against this document.

The short version: **lightweight SPL Memo transactions on Solana Devnet, with the
user's wallet signing their own stake commitment.** No custom program before the
submission deadline. An Anchor program is the recorded upgrade path.

## Why transactions rather than a program

The product sells one property: _this commitment existed at time T, before the
deadline, and was never altered._ Both halves come free from a plain transaction.

- **Existence at a time.** A confirmed transaction resolves to a slot with a
  network-assigned `blockTime`. That timestamp is set by the network, not by the
  application; it is an estimate and can be absent on some transactions, so
  verification must treat a missing `blockTime` as "not proven" rather than
  falling back to our clock.
- **Not altered.** Confirmed transaction history is append-only. A memo cannot be
  edited after the fact.

A program adds **program-enforced refusal** — an on-chain check that rejects a
commitment submitted after the deadline — plus on-chain queryable state (anyone
could enumerate a round's commitments without trusting our database). Those are
real gains, and they are why Anchor is the next step rather than a rejected
option.

But refusal is worth less than it sounds here. The party that would be refused is
the party submitting the transaction — us. An operator willing to fake a
commitment would simply never build the late transaction. Program enforcement
matters when the submitter is adversarial; it does not when the submitter _is_
the trusted backend. What is left is the product claim, and transactions deliver
it.

## Scope comparison

| Option                    | What it proves                                                        | Cost                                                                                                                        | Risk before 2026-11-20                                                                                        |
| ------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **SPL Memo transactions** | A hash existed on-chain by T; immutable                               | ~2–4 hours, one npm dependency, no deploy                                                                                   | **Low.** Worst case is an RPC hiccup; the idempotency key is designed to absorb a retry, once F20 writes them |
| **Anchor program**        | As above, **plus** program-enforced deadline and on-chain enumeration | 1–2 days: Rust, `solana-cli`/`avm`, `anchor-cli`, program deploy, IDL client, PDA design, a local validator to test against | **High.** Toolchain version mismatch is a known day-one trap, and the failure lands on the demo path          |
| **Full on-chain market**  | Everything above, with stakes and settlement as on-chain state        | Weeks: token program, escrow, settlement math on-chain, audit surface                                                       | **Not viable** for this submission                                                                            |

The middle option is not _worse_, it is _unaffordable_. A hackathon entry that
cannot run its own demo has no guarantee story at all.

## Transaction shapes

One Memo-program instruction per logical action. The memo text is versioned
(`v1`) so a future change is a new prefix rather than a silent reinterpretation
of old history. The Memo program takes arbitrary UTF-8 and stores nothing; there
are no accounts to manage and no program id of our own.

| Action           | Memo                                                           | Signer   | `purpose` (type `tx_purpose`) |
| ---------------- | -------------------------------------------------------------- | -------- | ----------------------------- |
| Stake commitment | `aisd:v1:stake:<roundId>:<commitmentHash>`                     | **user** | `prediction_commitment`       |
| Round open       | `aisd:v1:round:<roundId>:<deadline ISO-8601>`                  | operator | `round_record`                |
| Settlement       | `aisd:v1:settle:<roundId>:<winnerModelId>:<pot>:<backerCount>` | operator | `settlement`                  |

`blockchain_transactions.program_id` stays **null** for every row in this scope.
The column exists for the Anchor upgrade; leaving it null is the honest marker
that no program was involved.

Each row is designed to record `signature`, `status`, `user_id`, `round_id`,
`wallet_address`, `slot`, and a `payload` holding what the memo means
structurally (the nonce, the preimage fields) — the memo is a public one-liner,
the payload is our own bookkeeping. All of those are nullable today and nothing
writes this table yet; F20 is the first writer.

### Why the memo carries a hash and not the pick

A pick is private to the account that made it. `public.predictions` is
owner-select only (`predictions_select_own` in
[`20261118100800_rls_policies.sql`](../supabase/migrations/20261118100800_rls_policies.sql)),
and it stays private after settlement. Publishing `model_id` in a memo would
publish every user's pick to the world in plaintext, for the whole round, before
a single frame is rendered.

So the memo carries `hash(pick, stake, nonce)` and nothing else. The nonce is
stored in `blockchain_transactions.payload` — readable by its owner under
`blockchain_transactions_select_own`, and by the service role for verification —
and is **never** written into the memo.

The nonce is not there to stop a stranger brute-forcing the pick. There is no
direct oracle to check a guess against — the `predictions` row a guess would be
confirmed by is not readable. (There is a weak side channel: per-model aggregate
stakes and odds are published, so a small pool leaks some signal. That is not
enough to invert a hash, but "no oracle at all" is too strong a claim.) The
nonce's real job is to keep the preimage from being the trivially reconstructable
`hash(model_id, stake_points)`. That matters the moment a user discloses their
own preimage to prove something, which is the only way the pick is ever revealed.

**Consequence worth stating plainly:** the chain proves _a hash existed by T_. It
does not, by itself, tell anyone _which model that hash stands for_. Tying the two
together is a self-service verification — the owner supplies
`(pick, stake, nonce)`, anyone recomputes the hash and compares it to the memo.
That is exactly the scope F20 has always had ("verify-on-demand for linked
wallets"), and this record does not upgrade it into a public audit trail.

## Who signs what

| Action           | Signed by              | Fee paid by | Signature attests to                            |
| ---------------- | ---------------------- | ----------- | ----------------------------------------------- |
| Stake commitment | user's Phantom keypair | **server**  | _keypair X posted this hash before T_           |
| Round open       | operator keypair       | server      | _the operator declared this round and deadline_ |
| Settlement       | operator keypair       | server      | _the operator published this result_            |

Two points that must not be softened:

- **The server is the fee payer.** The user's keypair is a required co-signer,
  not the payer, so a Phantom account holding zero Devnet SOL can still stake and
  the server controls transaction shape. This is ordinary Solana fee-payer
  delegation and needs no program.
- **Phantom does not prominently display memo content** — an assumption about the
  wallet UI that should be re-checked against the version used in the demo (see
  residual risks). If it holds, the popup shows that a transaction is being
  signed; it does not put the commitment hash in front of the user in a legible
  way. So the popup is weaker evidence _to the user_ than its presence suggests.
  What makes the commitment inspectable is the verification recipe below, not the
  wallet UI. Do not describe the popup as the moment the user "sees" their
  commitment.

Round and settlement records are operator-signed because the operator genuinely
owns those actions. Describing them as user-attested would be a lie in the other
direction.

## The guarantee ladder

Each rung is a strictly stronger claim. A verification that establishes rung _n_
does not imply rung _n+1_. **The hackathon slice is designed to reach rung 2**
(nothing reaches any rung until F20 ships), and every user-facing statement must
be checked against rung 2, not against the rung above it.

1. **The operator posted a hash by T.** True of any confirmed operator-signed
   memo. Proves our record-keeping was ordered, not that a user staked.
2. **Keypair X posted this hash by T.** True of a confirmed _user-signed_ memo.
   This is the rung the MVP is built for. Note what the signature does and does
   not say: the server assembles the memo and computes the hash, so the user
   approves a server-authored value. Rung 2 proves _keypair X approved this
   hash_, not that the human read or chose it — the popup does not surface memo
   content legibly (see above).
3. **Keypair X is bound to account U.** Requires `wallets.verified_at` to be
   written from a confirmed transaction's signer (F20 will do this — see below).
   Without it, rung 2 says _(an address)_ staked, not _(this account)_ staked.
4. **The hash commits to the real pick and stake.** Requires the owner to
   disclose `(pick, stake, nonce)` and a verifier to recompute. The chain never
   establishes this on its own.

Rungs 1 and 2 are what the chain itself gives us. Rung 3 becomes available once
F20 writes `verified_at`; rung 4 always needs the owner's disclosure.

## What is not guaranteed (F23 source text)

- **That models ran honestly.** The backend generates, renders and judges. The
  chain sees none of it. `docs/sandbox-threat-model.md` already says this from the
  sandbox's side.
- **That the judge was impartial.** Same: a trusted-backend claim.
- **That a commitment corresponds to a stake in the pool.** `place_stake` remains
  authoritative for pool membership. A confirmed memo whose `place_stake` then
  failed is an _orphan_ — it exists, it is not a lie, and it did not back anything.
  The pool is what settlement pays out on.
- **Permanence.** Devnet is disposable. Validators can be reset and history wiped.
  These are demo-grade guarantees, not a production ledger. Say so rather than
  implying the opposite.

## Verification recipe

For a stake, given a `blockchain_transactions` row and the round it points at:

1. Fetch the transaction by `signature` from Devnet RPC and read `blockTime`.
2. Assert `blockTime < rounds.prediction_deadline`. _(A transaction that confirmed
   after the deadline proves nothing about a pre-deadline commitment; a missing
   `blockTime` proves nothing either.)_ Note the boundary: `place_stake` itself
   accepts `now() <= deadline`, while this check is strict. A commitment landing
   in the same instant as the deadline should be treated as **not** proven rather
   than argued about — the safe side is to reject it.
3. If the user has disclosed the preimage, recompute
   `hash(pick, stake, nonce)` and compare it to the `<commitmentHash>` in the
   memo text.
4. Confirm `predictions.commitment_hash` for that `(round_id, user_id)` matches
   the memo — this is what ties a confirmed transaction to a stored commitment.

Steps 1 and 2 are public: anyone can read a transaction. Step 4 is **not** a
public table read — `predictions` is owner-select only, so a third party needs
the service-role API (or the owner's own session) to compare the stored hash.
Step 3 is owner-initiated because it reveals the pick.

Until F20 revokes the direct `predictions` insert grant, a matching
`commitment_hash` does not by itself prove a stake "counted": a client can still
insert a 0-point prediction carrying a hash. Treat step 4 as complete only once
that grant is gone and `place_stake` is the sole write path.

F20 will ship this as `scripts/verify-commitment.mjs`, so the demo can _show_ a
check rather than assert one is possible. The script verifies timing and the
stored commitment; it cannot verify the pick unless the backer discloses the
preimage.

## Commitment lifecycle and the stake→memo sequence

This is the one place the scope can produce a consistent-looking lie, so the
order is fixed rather than left to the implementer.

**Order.** Pre-flight (round `OPEN`, deadline not passed by a safety margin,
model participates in the round, reserved balance covers the stake) → server
generates the nonce and the commitment hash → client signs the memo with Phantom,
server as fee payer → server submits and confirms → _then_
`place_stake(..., p_commitment_hash)`.

**An orphan memo is the accepted failure mode.** If `place_stake` fails after the
transaction confirmed — the round locked in between, the balance moved — the
transaction row stays `confirmed` with an `error` explaining the orphan, and no
`predictions.commitment_hash` is written. This is harmless and is exactly what
the pool-authority rule above covers: the pool pays out, and the verification
recipe's step 4 fails, correctly reporting that no stake counted.

The reverse order — `place_stake` first, then commit — is worse: it stores a hash
with nothing behind it, and the round can lock before the transaction lands,
leaving a commitment-shaped hole that looks exactly like a real one.

**Raising a stake requires a fresh memo.** The amount is in the preimage, so a
raise from 250 to 500 points is a different hash. `predictions.commitment_hash`
therefore names exactly one memo: the most recent confirmed one.
`blockchain_transactions.idempotency_key` is
`stake:<roundId>:<userId>:<commitmentHash>` — retrying the same memo hits a 23505
instead of duplicating it, while a raise is a new hash and a new key.

**A user rejecting the popup writes nothing.** No transaction existed, so a
`failed` row would record a non-event that later confuses the audit. Genuine
submission failures do get rows: an RPC error, a rejected transaction, or a
confirmation timeout land as `failed`/`timeout`, which is what F20's persistence
criterion is about.

**Blockhash expiry is a named path.** Solana transactions embed a recent
blockhash that goes stale in roughly a minute. A user who leaves the popup open
long enough will have their transaction rejected. The fix is to rebuild the
transaction and re-prompt; the record names it so it surfaces as a known case
rather than a mystery error mid-demo.

## `commitment_hash` must become immutable (F20)

`guard_prediction_update` freezes `model_id` and `stake_points` once the round
leaves `OPEN`, but **not** `commitment_hash`, and `place_stake` overwrites it with
`coalesce(excluded.commitment_hash, p.commitment_hash)`. A commitment that can be
rewritten after the deadline is not a commitment — it is a value with a good
reputation.

Be precise about the exposure. It is not an open door: `place_stake` re-checks
`OPEN` and the deadline, so the guard omission is not reachable through it for a
round that has left `OPEN`. The narrow gap is a same-model, same-points call
inside the window, which does not re-trigger the guard's own status check — plus
any service-role write. That makes this defense-in-depth rather than a live
exploit, which is exactly why it is a small F20 fix rather than an incident.

F20 owns it: recreate the guard so `commitment_hash` is frozen outside `OPEN`,
and revoke the direct `insert` grant on `public.predictions` so `place_stake` is
the only write path. The second half closes a hole the F18 work already
documented: a client can currently direct-insert a prediction that bypasses the
`funded`, `practice_mode` and balance gates and can carry a `commitment_hash` on a
0-point row (the `stake_points` default), so it inflates no pool but it can make a
hash look like a stake. F20 is the right place for the fix because nothing
legitimate should depend on that grant once a commitment is involved.

## Wallet binding (`wallets.verified_at`)

`linkWallet` stores whatever address the browser reports, with no signature
check. So a user-signed memo proves _keypair X posted this hash_, not _account U
staked_ — rung 2, not rung 3.

The fix costs no extra popup: on a confirmed stake memo, write
`wallets.verified_at` where `wallets.address` matches the transaction's signer.
The user already signed; that signature is the ownership proof. That closes rung
3 as a byproduct of an action they were taking anyway.

It does not retroactively verify an address linked but never used to sign, which
is the honest outcome: an unused link stays unverified.

## Prerequisite: Sign in with Solana creates no `wallets` row

**This blocks F20 at its first line.** A Phantom sign-in creates a `users` row
through the auth trigger, but no `wallets` row. `users.funded` is derived as
"a `wallets` row exists"
([`20261118100900_profile_sync_and_funding_status.sql`](../supabase/migrations/20261118100900_profile_sync_and_funding_status.sql)),
so a wallet-only account reads `funded = false`, the dashboard shows "No wallet",
and `place_stake` raises _"link a wallet to stake on a live round"_
([`20261119000800_f18_stakes_and_votes.sql`](../supabase/migrations/20261119000800_f18_stakes_and_votes.sql)).

In other words the demo path _sign in with Phantom → stake_ does not work today.
Two shapes of fix, and the choice belongs to whoever implements it, not to this
record:

- **Derive `funded` from the auth identity** — treat a `web3` identity as a
  wallet without a separate row.
- **Bridge the address into `wallets`** — insert the SIWS address on sign-in (or
  first use), keeping `wallets` the single source for addresses.

The second fits the existing derivation and the `verified_at` rule above better;
the first is smaller. Either way, F20 cannot be tested without it, so it is
listed as a dependency rather than discovered later.

## Configuration F20 adds

Follow the existing on-demand pattern in
[`apps/web/lib/config/server.ts`](../apps/web/lib/config/server.ts) — a missing
value must break only the code paths that need it, not page rendering:

- `SOLANA_RPC_URL` — a Devnet RPC endpoint. The public `api.devnet.solana.com` is
  rate-limited and is fine for a rehearsal, not for a demo under lights.
- `SOLANA_OPERATOR_KEYPAIR` — the fee-payer/operator secret, server-only, in the
  style of `OPENROUTER_API_KEY`. Never in the client bundle.
- A cluster guard: refuse to build anything for a non-devnet cluster in
  development (non-negotiable #4).

## Library

`@solana/web3.js` (3.2.1 on npm at the time of this record) on both client and
server. The client half is one `signTransaction` call against
`window.solana`, which every Phantom example and every troubleshooting answer
assumes.

`@solana/kit` (8.6.0) is the forward-looking choice and is recorded as the
alternative considered — not rejected on merit, but on deadline risk: unfamiliar
APIs are a poor bet on submission day.

## Upgrade path to Anchor

The same preimage, the same hashes, a different transport. Moving to a program
means:

- PDAs `["round", roundId]` holding the round's deadline, and
  `["commit", roundId, user]` holding a commitment — so a commitment is an
  account, not a memo.
- The program rejects `submit_commitment` when `Clock::get().unix_timestamp >
deadline`: genuine program-enforced refusal, which this scope does not have.
- On-chain enumeration: anyone can list a round's commitments without trusting
  our database, which is the real prize.

`blockchain_transactions.program_id` stops being null at that point, and the
`tx_purpose` values already exist. Nothing in the commitment scheme changes, which
is why this is an upgrade rather than a rewrite.

## Historical comments in applied migrations

Several applied migrations still describe G1 as undecided, because they were
written before this decision:

- `20261118100700_blockchain_transactions.sql` — "G1 (Anchor vs lightweight tx
  records) is gated until M5", and `program_id` as "Anchor program id when G1
  lands".
- `20261118100000_init.sql` — the `tx_purpose` enum commented as usable "for
  lightweight tx records now and an Anchor program later (G1 gated until M5)".
- `20261118100400_predictions.sql` — `commitment_hash` described as readable by
  "lightweight tx records or Anchor … later (G1 gated until M5)".
- `20261118100100_users_wallets.sql` — the wallet called an _optional_ link. This
  is the most misleading of the four: `funded` now derives from a `wallets` row,
  so a wallet is required to **stake**, and Sign in with Solana creates no row.

These are historical records of an earlier state and are **not** edited, because
rewriting an applied migration changes what it says a past schema meant. This
document supersedes them. If a future migration touches these objects anyway,
correcting the comments then is fine.

## Residual risks

1. **A user-signed memo proves the keypair, not the account** until
   `wallets.verified_at` is written. Rung 2 is the honest claim for the MVP.
2. **Orphan memos are possible** by design. They are recorded, not hidden, and the
   pool remains authoritative.
3. **Devnet is disposable.** History can be wiped; the guarantees are demo-grade.
4. **Staking requires a wallet; the rest of the product does not.** An account
   with no linked wallet cannot stake — `place_stake` gates on `funded`. An
   email account that links a wallet _can_ stake, which is the intended flow
   (`REQUIREMENTS.md`'s wallet-link decision). Practice-mode accounts cannot.
   Browsing, watching and voting never need a wallet (non-negotiable #5), and
   F23 must say so, because this scope adds a signature prompt to the one action
   that already required a wallet.
5. **Fixing the Sign in with Solana gap does widen participation** — it lets
   wallet-only accounts stake for the first time. That is a fix, not a side
   effect, but it should be stated rather than discovered.
6. **The verification recipe is only as good as the disclosure.** Step 3 requires
   the owner to reveal their pick; nothing makes that automatic.
7. **Phantom's memo display is an assumption, not a verified fact.** The claim
   that the popup does not surface memo content legibly should be re-checked
   against the Phantom version used in the demo. If it does display the memo, the
   rung-2 caveat is softer than stated — which is a pleasant surprise, not a
   problem.
8. ~~**`TxPurpose` has no TypeScript mirror.**~~ Resolved (F20): `TX_PURPOSES`
   / `TxPurpose` in `packages/shared/src/index.ts`.
