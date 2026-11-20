# SOL wagering demo checklist (Devnet only)

Valueless Devnet test SOL. Mainnet is refused in code (genesis-hash check).
Design and trust boundary: [`solana-integration.md`](solana-integration.md).

## One-time setup

1. **Migrations** — `20261120000100/200/300` applied (`npm run db:push`).
2. **Server keys** in `apps/web/.env.local` (gitignored; never commit, never
   `NEXT_PUBLIC_`): `SOLANA_OPERATOR_KEYPAIR`, `SOLANA_TREASURY_KEYPAIR`, and
   preferably a dedicated `SOLANA_RPC_URL` for Devnet — the public endpoint
   returns 429s under load. Fund operator ≥ 0.5 SOL and treasury ≥ 1 SOL at
   <https://faucet.solana.com> (the RPC airdrop is closed).
3. **Pipeline config** — `INTERNAL_JOB_SECRET`, digest-pinned
   `RENDER_SANDBOX_IMAGE`, `OPENROUTER_API_KEY`, a seated judge model.
4. **Demo wallets** — Phantom → Settings → Developer settings → **Testnet
   mode on**, network **Solana Devnet**. Each demo wallet needs ~0.2 Devnet SOL
   (faucet). Sign in with Phantom, or link the wallet to an email account.
5. **Sanity checks** (both talk to real Devnet):
   - `cd apps/web && npx tsx --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json ../../scripts/sol-devnet-smoke.ts`
   - `… ../../scripts/sol-e2e.ts` — full money path against the hosted DB
     (creates a labelled `e2e-sol-<ts>` round and two test accounts).

## Demo run (2–3 min)

1. **Admin → Create Game**, "Devnet SOL wagering round" checked, fee 5%, stall
   safeguard optional, ante deadline ~60–90 s out. The round-open memo posts to
   Devnet.
2. **Round page** → pick a model → **Sign the ante in Phantom**. Status goes
   _Approve in Phantom → Confirming on Devnet → Accepted_, with an Explorer
   link. Only "Accepted" counts.
3. At the deadline the app advances itself: the in-process scheduler locks the
   round and starts generation within ~2 s, and **live betting opens**. Nothing
   to curl. (`POST /api/internal/jobs/tick` runs the same pass by hand if you
   want to watch it happen; `ROUND_SCHEDULER=off` disables the scheduler.)
4. Watch code + previews stream and token bars climb toward the 75% marker.
   Place a **live wager** or two; the multipliers move only after acceptance.
5. The first model to reach 75% (or finish/fail) **closes betting** — the
   banner names the model and reason; the close memo posts to Devnet.
6. Judging runs after the close, then settlement and payouts follow on their own
   within a few seconds. Payouts show **Paid** with Explorer links only once
   confirmed; the settlement memo is a record, shown separately.

## Recovery

| Symptom                              | Action                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Round past its deadline, still OPEN  | Check the server log for `automation.tick.failed`; `ROUND_SCHEDULER` must not be `off` |
| ------------------------------------ | -----------------------------------------------------------------------                |
| Wager stuck "confirming"             | `POST /api/internal/jobs/sol {"action":"reconcile","roundId":…}`                       |
| Settlement says wagers in flight     | reconcile, then settle again (safe to repeat)                                          |
| Payout "Sending"/uncertain           | run the payouts job again — it never double-pays                                       |
| Payouts "On hold"                    | treasury short; fund it, then set those rows back to `pending`                         |
| Round cancelled                      | `POST /api/internal/jobs/sol {"action":"refund-cancelled","roundId":…}` then payouts   |
| 429 from Devnet                      | switch `SOLANA_RPC_URL` to a dedicated Devnet RPC                                      |
| Phantom shows a mainnet warning      | Testnet mode is off — turn it on                                                       |

## Say on camera

- One transaction = SOL transfer + commitment memo; the server co-signs only
  inside the window, so a late wager never moves SOL.
- Betting closes before anything past 75% is shown; judging only after.
- Ties split by dead heat; the crowd vote never moves SOL.
- The chain proves who paid what, when, and that winners were paid. Honest
  judging and custody are operator claims. **Devnet test SOL has no value.**
