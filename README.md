# Zelto

Zelto is a live arena for language models. Three competitors get the same
creative brief — a spinning donut, a pulsing reactor core — and write code that
**renders**. The audience watches the code stream in chunk by chunk and the
artwork take shape, wagers valueless **Solana Devnet SOL** on which model will
follow the brief, and, once betting has closed, votes on which result is best.

Two outcomes per round, never conflated:

- **Conformance** is measured — deterministic checks (the render ran, produced
  the brief's frames, at the brief's dimensions) plus a vision **judge model**
  ruling on whether the frames follow the brief. A model that fails the checks
  forfeits and can never win fan-favourite points.
- **Best** is the crowd's — a vote that opens only after betting closes, and
  that never moves SOL.

Every wager is one Solana transaction: a System transfer into the round treasury
plus a Memo carrying `sha256(round|wager|model|lamports|nonce)`. The user's
Phantom wallet signs it, the operator co-signs and pays the fee, and the round's
open, close and settlement are recorded as operator-signed memos. The network
stamps the time, so a commitment cannot be backdated. Betting closes before any
output past the first model's **75% token mark** is visible — "close, then
publish".

Devnet only, and valueless. Mainnet transfers and real-money wagering are
blocked pending legal and security review; the Solana module refuses any RPC
whose genesis hash is not Devnet's. Built for the UBC 2026 Hackathon, Track 03
(Consumer Applications).

> **Naming.** The product is **Zelto**. A handful of internal identifiers
> (`@ai-showdown/shared`, the `ai-showdown-*` container image tags, the Supabase
> `project_id`) still carry the working name and are left alone so existing
> images, linked projects and build state keep working.

> **Pivots.** The format was re-scoped twice, both times documented at the top
> of [`REQUIREMENTS.md`](REQUIREMENTS.md): on 2026-11-19 from LeetCode-style
> coding challenges to visual briefs, and on 2026-11-20 from a points pool to
> live Devnet SOL wagering. The points pool and its tables remain in the schema
> for history; no round is created with them.

## How a round runs

A round is created by an admin and moves `CREATED → OPEN → LOCKED → RUNNING →
EVALUATING → SETTLED → ARCHIVED`. Three windows decide what a viewer may see and
do:

1. **Ante** — `OPEN` until `prediction_deadline`. No code or render exists. One
   accepted ante per account picks the model it backs, and is the ticket to live
   betting.
2. **Live** — while the models generate. Code and preview renders stream in;
   eligible accounts keep wagering, and the estimated multipliers move with
   accepted wagers only.
3. **Closed** — the moment the first model reaches 75% of its output-token
   budget, or earlier if a model finishes or fails. The pipeline checks each
   chunk **before** it is stored or previewed, so the close commits before
   anything past the threshold is visible. Final renders, gate results, judge
   verdicts and crowd votes are refused by the database until then.

Then judging, settlement and automatic Devnet payouts. Tied winners split by
dead heat; a void round refunds every wager in full; payouts are net of a
disclosed platform fee (5% by default, winning rounds only).

A round is **priced by its tier**. Competitors sit on one of four rungs —
cheap ($2), mid ($4), frontier ($6), exclusive ($10) — and every model in a
round must share the rung. The ante is derived from the tier at creation, never
typed, and the tier is frozen with the round.

## Tech stack

- Next.js 16 (App Router), React 19, TypeScript
- Tailwind CSS v4 with a committed design system
- Supabase — Postgres, auth (email/password and Sign in with Solana), RLS
- OpenRouter — one integration for every competitor and the judge
- Solana Devnet — SPL Memo + System transfers, no custom program
- Docker — a digest-pinned headless Chromium image renders every frame
- Vitest for unit tests; SQL assertion scripts for the schema

## Project structure

```
apps/web                        Next.js app (server logic and routes)
  app/(public)                  landing, login, rounds, leaderboard, models,
                                results, What's on-chain
  app/(app)                     dashboard, My predictions, profile, wallet link
  app/admin                     round creation (server-role gated)
  app/dev/pipeline/[id]         developer watcher for a running round
  app/api/                      REST surface (see API routes below)
  components/                   design primitives, icons, logo, hero field,
                                live round panel, SOL market board
  lib/server/services/          business logic: auth, competitions, briefs, llm,
                                pipeline, evaluation, wagering, scoring,
                                results, leaderboard, models
  lib/server/integrations/      Supabase, OpenRouter, Docker, Solana adapters
  lib/config/                   typed, on-demand environment accessors
  proxy.ts                      per-request auth gate (Next 16 `proxy.ts`)
packages/shared                 shared TypeScript types
sandbox/                        isolation boundary
  render/                       headless Chromium renderer (the live path)
supabase/                       migrations, seeds, CLI config, SQL assertions
scripts/                        operator and dev scripts
docs/                           Solana design, threat model, demo checklist
```

Route groups `(public)` and `(app)` do not appear in URLs; the authenticated
shell sits behind a Suspense-wrapped `requireUser()`.

## Getting started

Requirements: Node.js 22 (the Docker image uses `node:22-alpine`), npm, and
Docker with Compose v2 for the sandbox.

```bash
npm ci
cp apps/web/.env.example apps/web/.env.local   # fill in the values
npm run dev
```

Open http://localhost:3000. The app needs both `NEXT_PUBLIC_SUPABASE_*` values
to start at all — the Supabase clients throw without them. The wagering and
pipeline paths need more (below), but a missing key breaks only the paths that
use it, never page rendering.

## Environment configuration

Everything lives in `apps/web/.env.local` (gitignored). Copy
[`apps/web/.env.example`](apps/web/.env.example) — it carries a comment for
every variable.

**Public**

| Variable                               | Purpose              |
| -------------------------------------- | -------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public Supabase key  |

**Required for the core loop**

| Variable                    | Purpose                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS for evaluation, settlement and wagering writes   |
| `OPENROUTER_API_KEY`        | Competitor and judge calls                                    |
| `INTERNAL_JOB_SECRET`       | Shared secret for `/api/internal/jobs/*`; unset = fail closed |
| `RENDER_SANDBOX_IMAGE`      | Digest-pinned Chromium image — renders every frame            |
| `SANDBOX_IMAGE`             | Digest-pinned Python sandbox (legacy evaluation path only)    |

**Required for SOL wagering (Devnet only)**

| Variable                  | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `SOLANA_OPERATOR_KEYPAIR` | Fee payer and co-signer; signs round, close, settlement memos                 |
| `SOLANA_TREASURY_KEYPAIR` | Receives wagers; signs payouts and refunds                                    |
| `SOLANA_RPC_URL`          | Optional; defaults to `api.devnet.solana.com` (rate-limits under load)        |
| `SOL_USD_REFERENCE_PRICE` | Optional fallback SOL/USD price for pricing the ante if the spot feed is down |

Keypairs are a `solana-keygen` JSON byte array or base58, read on demand, and
must differ from each other. Fund both at <https://faucet.solana.com> (operator
≥ 0.5 SOL, treasury ≥ 1 SOL). The ante is priced from the live mainnet SOL/USD
spot price as a reference — the lamport amount recorded with the wager is
authoritative, and the quote says whether it came from the spot feed or a
configured fallback.

**Optional tuning** — all defaulted, safe in production:
`OPENROUTER_BASE_URL`, `OPENROUTER_TIMEOUT_MS` (60000),
`OPENROUTER_MAX_ATTEMPTS` (3), `OPENROUTER_FORFEIT_THRESHOLD` (3),
`CHUNK_MAX_TOKENS` (1536), `CHUNK_MAX_CHUNKS` (4), `DOCKER_BIN` (`docker`),
plus per-runner limits (`SANDBOX_*`, `RENDER_SANDBOX_*`).

The model lineup is **not** environment configuration: it is the active rows in
`public.llm_models`, ordered by `sort_order`, with `role = 'competitor'` for the
lineup and `role = 'judge'` for the judge. The judge never competes.

Never commit real keys, and never give a server-only variable a `NEXT_PUBLIC_`
prefix.

## Authentication and accounts

Login-first, with two identity shapes:

- **Sign in with Solana** (Phantom, Supabase's Web3 provider) creates a
  wallet-identified account.
- **Email/password** creates an account that may link a wallet on a first-run
  `/link-wallet` screen, or continue in practice mode.

How it is enforced:

- `apps/web/proxy.ts` runs on every non-asset request: it refreshes the session
  cookie, redirects signed-out hits on `/dashboard`, `/predictions`, `/profile`,
  `/link-wallet` to `/login?next=…`, and bounces signed-in users away from
  `/login`. Adding a protected prefix means adding it to `PROTECTED` there.
- `app/(app)/layout.tsx` wraps its children in `requireUser()`, which still runs
  when a layout is reused on client-side navigation.
- Postgres RLS is the final gate on every read and write.

Two derived facts decide what an account may do, and neither is client-writable:
`public.users.funded` is true exactly when a `public.wallets` row exists
(trigger-maintained), and `practice_mode` is self-service because it can only
reduce access. Browsing, watching and voting never need a wallet; only wagering
does. Rounds are created by admins — users join them.

Supabase dashboard settings auth depends on (not app config):

- Email provider with **Confirm email off**, or sign-up returns no session.
- Web3 provider with **Solana enabled**, matching `supabase/config.toml`'s
  `[auth.web3.solana]`.
- Provider credentials live in the dashboard only.

## Database

`supabase/migrations/` holds 37 ordered SQL files: users, wallets, the model and
brief catalogs, rounds, predictions, evaluation, results, blockchain
transactions, RLS, the profile-sync and funding triggers, the lifecycle audit,
and the later feature layers — the visual brief schema, chunked pipeline,
stakes and votes, settlement, model analytics, and the 2026-11-20 SOL wagering
set (tx purposes, wagering tables and guards, SOL competition creation, points
retirement, SIWS wallet-on-signup, frozen commitments, the live-wager minimum,
and model tiers).

Notable database-level rules:

- `public.transition_round(...)` is the compare-and-set lifecycle RPC; repeats
  of the target status are no-ops so the audit trail never gains a duplicate.
- `public.lock_due_rounds(...)` locks every due `OPEN` round in one transaction
  using `for update skip locked`.
- `public.create_sol_competition(...)` creates a priced round atomically and
  refuses mixed tiers, unseated models and a judge in the lineup.
- `wager_reserve` re-checks the betting window under a round row lock before the
  operator will co-sign.
- `close_betting` is the single write that closes the window; the vote, gate and
  judge paths are refused until it has run.
- `ensure_round_stakes_settled` refuses to finalize a round while any
  conformance stake is unsettled, so a void cannot silently keep funds.
- `commitment_hash` is immutable outside `OPEN`, and the direct prediction
  insert grant is revoked — the RPC is the only write path.

Seeds in `supabase/seeds/` add three visual briefs (isometric donut, pulsing
reactor core, light tunnel), the competitor lineup, the judge, and the four
tier rungs. Briefs seed as drafts; `npm run briefs:validate` renders each
reference implementation in the pinned Chromium sandbox and publishes only what
renders cleanly.

Assertion scripts in `supabase/tests/` verify duplicate rejection, constraints,
RLS and the feature guarantees. Run them against the throwaway Postgres harness
— `npm run db:test` starts a disposable container, applies every migration and
runs the whole suite; `npm run db:test:migrations` applies migrations only.
They can also be pasted into the hosted Supabase SQL editor: every assertion
raises `FAIL: …` on violation, a final select confirms success, and everything
rolls back.

Apply schema to a hosted project:

```bash
npm run db:link -- --project-ref <your-project-ref>   # once
npm run db:push                                       # migrations, in order
npm run db:seed:briefs                                # migrations + seeds
```

Each new auth user gets its `public.users` row from the `on_auth_user_created`
trigger; without it the foreign keys from `wallets` and wagers fail.

## How a round advances itself

Nothing has to be triggered by hand. When the Next server boots,
`apps/web/instrumentation.ts` starts an in-process scheduler
(`lib/server/services/automation/scheduler.ts`) that ticks every 2 seconds and
advances every round as far as it can go:

1. **Lock** — moves every `OPEN` round past its ante deadline to `LOCKED`.
2. **Generate** — starts the pipeline for locked or half-finished rounds, in the
   background, one round at a time. The round is claimed with an atomic
   compare-and-set, so a manual job and the scheduler cannot both generate it.
3. **Settle** — turns `EVALUATING` rounds into a decided outcome, then sends the
   Devnet payouts settlement queued (paced to every 10s, since payouts talk to
   an RPC that rate-limits).

So the timer running out _is_ the trigger: the ante window closes, generation
and live betting start, the first model to 75% closes betting, rendering and
judging follow, and the result settles and pays out — no terminal, no cron
container. A round that fails is retried with a backoff of up to 30s, and one
round failing never stops the next from advancing.

The scheduler needs `SUPABASE_SERVICE_ROLE_KEY` (it drives server-role
operations) and is controlled by:

| Variable                      | Default | Meaning                                      |
| ----------------------------- | ------- | -------------------------------------------- |
| `ROUND_SCHEDULER`             | on      | `off` disables it — use on a second instance |
| `ROUND_SCHEDULER_INTERVAL_MS` | `2000`  | Tick interval; minimum 500                   |

It is single-instance by design: the deploy target is one container that owns
the Docker socket. Running it on several instances stays correct thanks to the
claim and the idempotency below, but duplicates provider spend.

## Internal jobs

The same stages are also exposed as internal endpoints, all under
`/api/internal/jobs` and all gated by `x-internal-job-secret: $INTERNAL_JOB_SECRET`.
A missing secret means every one of them refuses to run. Each is safe to call
twice — they are what the scheduler calls, and what an operator uses to retry a
single step.

| Endpoint        | What it does                                                                           |
| --------------- | -------------------------------------------------------------------------------------- |
| `tick`          | One pass of the scheduler: lock, settle, payouts, and report what generation can start |
| `lock-rounds`   | Moves due `OPEN` rounds to `LOCKED` (the ante clock)                                   |
| `run-rounds`    | Drives `LOCKED`/half-finished rounds through generation, render, close, gate and judge |
| `settle-rounds` | Turns stored verdicts into an outcome and a payout                                     |
| `rejudge`       | Re-runs the judge on **stored** frames; never settles                                  |
| `sol`           | `reconcile`, `payouts`, `refund-cancelled`, `chain-records`                            |

```bash
curl -X POST https://<host>/api/internal/jobs/tick \
  -H "x-internal-job-secret: $INTERNAL_JOB_SECRET"
```

`run-rounds` produces verdicts and does not settle; keeping them apart is what
lets a judge outage leave a round retryable instead of settled on a guess. The
`sol` actions are the money path: `reconcile` resolves wagers still confirming,
`payouts` sends and resolves queued payouts (it never double-pays), and
`chain-records` backfills missing round and settlement memos and retries ones
that did not confirm.

## The pipeline

1. **Generate.** Every model receives the identical brief and the identical
   chunk policy (4 chunks × 1536 tokens by default), recorded on each execution
   so "same policy for everyone" is checkable against a stored run rather than
   asserted from current code. Every model fills the full chunk schedule, so
   "finishes" lands at the same chunk index for every competitor and one model's
   pace cannot close the window mid-race.
2. **Render.** Finished chunks render progressively in the quarantined iframe;
   a chunk that does not parse degrades to showing code growth rather than
   failing the round.
3. **Close.** `close_betting` commits before any output past 75% is visible.
4. **Gate and judge.** The stored source renders in the digest-pinned Chromium
   sandbox at explicit time steps — never wall-clock, so renders are
   reproducible. Deterministic checks decide qualification; only qualified
   renders reach the judge.
5. **Settle.** A pure resolver turns verdicts into per-model outcomes and one
   round outcome, then parimutuel math splits the pool in exact-integer
   lamports, and payouts go out from the treasury.

Failure behaviour is explicit and tested: a render error or timeout forfeits; a
judge that cannot see the frames is `unavailable` and the round stays retryable;
an off-brief render is `not_conformed` but keeps fan-favourite eligibility; all
models forfeiting voids the round and refunds every wager; equal conformance
falls to the crowd vote, and a tied vote resolves by a recorded `tie_break`
rule.

## Judging

Conformance is decided by a vision model resolved **by role** — whichever active
`llm_models` row has `role = 'judge'` (at most one). It reuses the competitor
OpenRouter client, so retries, timeouts and typed failures behave identically,
and each ruling is its own `model_executions` row with `run_type = 'judge'`.

The properties that make a ruling trustworthy:

- **The rubric is data.** Criteria and weights come from the brief, and each
  weight is copied onto the stored verdict.
- **`conformed` is derived, not asserted.** The parser computes it as the
  conjunction of per-criterion answers, so a self-contradicting reply cannot
  become a pass. A reply that invents or omits a criterion is rejected — a
  partial ruling would mean something different per model.
- **A non-answer is a typed failure,** never a silent pass or fail.
- **Judging re-reads stored frames,** so a re-judge never re-generates or
  re-renders.

## Solana: what the chain proves, and what it does not

The chain holds **records, not enforcement**: SPL Memo and System transfers on
Devnet, with no custom program. An Anchor program with program-enforced
deadlines is the documented upgrade path.

- **Wagers.** One transaction: the user's SOL to the round treasury plus
  `aisd:v2:wager:<roundId>:<wagerId>:<commitment>`. The memo carries only the
  hash, so the pick stays private until the backer discloses it. The operator is
  the fee payer and a required signer; a wallet cannot broadcast a valid wager on
  its own, so a late wager is refused before any SOL moves. A wager counts only
  when the server re-reads the confirmed transaction from Devnet, checks the
  message bytes match the prepared ones, and checks the treasury grew by exactly
  the wager amount.
- **Round records.** Open, close (with reason) and settlement are operator-signed
  memos, retry-safe via an idempotency key.
- **Payouts.** Ordinary transfers from the treasury.

Anyone can check these: **Verify on Devnet** on My predictions, the **On-chain
record** panel on round and result pages, or `scripts/verify-commitment.mjs`
from the terminal.

What this does **not** prove: that the models ran honestly or the judge was
impartial; that betting closed by the stated rule (the backend enforces it; the
chain only timestamps); or that the treasury — an operator wallet, not a
contract — holds the pool safely. Devnet is disposable, so these are demo-grade
guarantees. The guarantee text has exactly one home,
[`apps/web/lib/chain-guarantees.ts`](apps/web/lib/chain-guarantees.ts), and the
source of truth, with every memo format and the trust table, is
[`docs/solana-integration.md`](docs/solana-integration.md).

## Sandbox and the browser quarantine

**LLM-generated code never runs on the application server.** Every render runs
in a fresh container from `sandbox/render/` — no network, read-only rootfs,
CPU/memory/pid limits, a cap on output size, a wall-clock timeout, non-root, and
all capabilities dropped. The image is pinned by digest because a tag would
re-pull and change what a past verdict meant; the runner refuses a tag-only
reference. The Python runner in `sandbox/` predates the visual pivot and still
backs the legacy evaluation path.

In the viewer's browser, generated code runs only in an iframe with
`sandbox="allow-scripts"` and **never** `allow-same-origin`, from `srcdoc` with
a CSP of `connect-src 'none'` — no access to the app origin, cookies or storage.
Those rules are not optional.

Build and pin the images:

```bash
npm run sandbox:render:build
docker image inspect ai-showdown-render:chromium \
  --format '{{index .RepoDigests 0}}'
```

Put the full `name@sha256:…` reference in `.env.local` as
`RENDER_SANDBOX_IMAGE` (and `SANDBOX_IMAGE` for the Python runner). Control
stack, measured attack results and residual risk:
[`docs/sandbox-threat-model.md`](docs/sandbox-threat-model.md).

## Design system

One committed visual world: organic cybernetic minimalism. Monochrome
instrumentation carries a single magenta and a single violet; halftone dot
fields, film grain and a WebGL flow field are the only organic material. It is
dark-only by design.

- [`apps/web/DESIGN.md`](apps/web/DESIGN.md) — the built system
- [`apps/web/.impeccable/design.json`](apps/web/.impeccable/design.json) — the
  same tokens, machine-readable
- [`apps/web/PRODUCT.md`](apps/web/PRODUCT.md) — product truth the interface must
  not contradict
- [`apps/web/app/globals.css`](apps/web/app/globals.css) — where the tokens
  actually live (Tailwind v4 `@theme` plus a `:root` block)

Conventions when touching the UI:

- Never use raw Tailwind palette classes (`zinc-*`, `blue-*`). Use the tokens:
  `bg-void`, `text-ink`, `text-muted`, `text-faint`, `border-hairline`,
  `text-magenta`, `text-violet`.
- Reach for the primitives in `apps/web/components/ui.tsx` (`Panel`, `Status`,
  `Meter`, `PageHeader`, `SectionHeading`, `EmptyState`, `Readout`) and the icon
  set in `components/icons.tsx`. Icons are authored SVGs, never font glyphs.
- Status is a 6px dot plus a word, never a filled colour chip. Selection and
  phase must be legible without colour.
- The hero vortex (`components/vortex-field.tsx`) must keep its
  `prefers-reduced-motion` still frame, its CSS underlay fallback, and its
  pause-when-offscreen behaviour.
- Copy uses the post-pivot vocabulary — brief, render, conformance, crowd vote,
  stake/wager. Demo data on the landing page is labelled synthetic; never add
  fabricated users, win rates, testimonials or benchmarks.

## API routes

Public and authenticated surfaces, all under `apps/web/app/api`:

- `health`
- `competitions`, `results`, `results/[id]`, `leaderboard`, `models/analytics`
- `rounds/[id]`, `rounds/[id]/progress`, `rounds/[id]/pool`,
  `rounds/[id]/stakes`, `rounds/[id]/votes`, `rounds/[id]/records`
- `rounds/[id]/wagers/prepare`, `rounds/[id]/wagers/submit`,
  `wagers/[id]/verify`
- `stakes` — the caller's own history, scoped by `requireUser()` with no user-id
  parameter
- `account/complete`, `auth/callback`
- `admin/competitions` (server-role gated)
- `internal/jobs/{lock-rounds,run-rounds,settle-rounds,rejudge,sol}`

Errors go through the shared handler in
`lib/server/http/api-error.ts`; background work uses `runBackgroundTask`. Logs
are structured, carry a correlation id, and redact credential-like fields and
private evaluation fields such as prompts and generated code.

## Deployment

The app ships as a production Docker image (Next.js standalone output, non-root,
port 3000) and needs a container-capable host — it spawns the Docker CLI at
runtime for the render sandbox, so a VM or equivalent is required rather than a
serverless platform. Supabase is hosted and Solana is Devnet. `NEXT_PUBLIC_*`
values must be present at build time, everything else at runtime.

```bash
docker compose up --build          # loads apps/web/.env.local if present
docker build -t ai-showdown .      # plain Docker (image tag keeps the working name)
docker run --rm -p 3000:3000 --env-file apps/web/.env.local ai-showdown
```

Secrets are provided at runtime and never baked into the image —
`.dockerignore` excludes every `.env` file from the build context.

## Security

- Private keys and API keys stay server-side. Server config modules import
  `server-only`, so an accidental client import fails the build.
- Only intended public values carry `NEXT_PUBLIC_`.
- The service-role key bypasses RLS: it is read only from `lib/server/**` and
  never serialized into a response.
- Auth is layered rather than trusted once: `proxy.ts`, `requireUser()` in the
  app layout, then RLS in Postgres.
- Generated code is quarantined twice — in the sandbox for evaluation, in a
  sandboxed iframe for viewing.

## Development commands

Run from the repository root.

| Command                             | What it does                                                    |
| ----------------------------------- | --------------------------------------------------------------- |
| `npm run dev`                       | Next.js dev server on :3000                                     |
| `npm run build`                     | Optimized production build                                      |
| `npm run lint`                      | ESLint                                                          |
| `npm run format`                    | Prettier, write                                                 |
| `npm run format:check`              | Prettier, check only                                            |
| `npm test`                          | Vitest unit tests (no network)                                  |
| `npm run typecheck`                 | `next typegen` then `tsc --noEmit` — run after moving a page    |
| `npm run db:link`                   | Link the Supabase CLI to a hosted project                       |
| `npm run db:push`                   | Apply migrations in filename order                              |
| `npm run db:seed:briefs`            | Migrations plus seeds                                           |
| `npm run db:test`                   | Migrations + SQL assertions in a throwaway container            |
| `npm run briefs:validate`           | Render and publish validated briefs                             |
| `npm run tier:validate -- <tier>`   | Check a tier's models end to end (prompt → OpenRouter → render) |
| `npm run sandbox:build`             | Build the Python sandbox image (legacy path)                    |
| `npm run sandbox:render:build`      | Build the Chromium render image                                 |
| `npm run sandbox:check`             | Sandbox persistence probes                                      |
| `npm run dev:pipeline`              | Seat, open, lock and run a round; prints the watcher URL        |
| `npm run round:settle -- <roundId>` | Settle a round through the internal job                         |

The live OpenRouter integration test is skipped unless `OPENROUTER_API_KEY` and
`OPENROUTER_TEST_MODEL_ID` are set:

```bash
OPENROUTER_API_KEY=… OPENROUTER_TEST_MODEL_ID=… npx vitest run \
  test/integration/openrouter.integration.test.ts --root apps/web
```

## Demo

The end-to-end run must fit 2–3 minutes. The rehearsed flow — admin creates a
priced round, a viewer signs the ante in Phantom, betting opens on generation,
the first model to 75% closes it, judging and settlement follow, payouts confirm
with Explorer links — is written out step by step, with one-time setup, sanity
checks and a recovery table, in
[`docs/sol-demo-checklist.md`](docs/sol-demo-checklist.md).

Say on camera: one transaction = transfer + commitment memo, and the server
co-signs only inside the window, so a late wager never moves SOL; betting closes
before anything past 75% is shown; judging runs only after the close.

## Limitations

- Devnet only. Valueless test SOL; no real money, tokens or NFTs.
- The backend is trusted for execution, judging and custody. The chain proves
  timing and immutability of records, not honesty.
- Guarantees are demo-grade: Devnet history can be wiped.
- Points rounds are retired; legacy tables remain for history.
- Blender-style challenges are out of scope — render times do not fit the demo.
