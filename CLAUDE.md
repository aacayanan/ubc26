# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Zelto** — a live visual showdown where LLMs are given a creative brief (a spinning donut, a pulsing reactor core) and write code that **renders**. The audience watches the code stream in chunks and the artifact take shape. **Conformance** (does it run, does it follow the brief) is decided by deterministic checks plus a vision judge model; **"best"** is decided by the crowd. Users stake points on a model _before_ the deadline via a **parimutuel pool** — a commitment hash recorded on-chain, so the record cannot be backdated. Built for the UBC 2026 Hackathon, Track 03 (Consumer Applications), on Solana Devnet. Submission deadline: **November 20, 2026, 12:00 PM CST**.

**Pivot (2026-11-19):** this replaced the original plan of standardized Python coding challenges judged on accuracy/speed/code length. That format read as LeetCode homework. Speed and code-length categories are gone; challenges are now visual briefs. See the pivot notice at the top of `REQUIREMENTS.md`.

Repo state: monorepo scaffolded 2026-11-18, M0 done and M1 accounts/shell done (F4, F5 shipped; F6 profile sync partial), F7 lifecycle and F11 deadline locking done (merged), M3 sandbox runner (F13) landed, F12's visual brief bank seeded and validated (Chromium render sandbox, versioned seeds, publish gate), M4's OpenRouter client (F16) merged, and the F17 chunked pipeline landed with the minimal F31 judge it depends on (2026-11-19) — Next.js app in `apps/web`, shared types in `packages/shared`, lint/format tooling, production Dockerfile (standalone output), Supabase schema in `supabase/migrations/` (all core entities, constraints, RLS policies, profile-sync trigger, `transition_round`/`lock_due_rounds`/`seed_brief`/`publish_brief` RPCs) with assertion tests in `supabase/tests/` and CLI scripts `db:link`/`db:push`/`db:seed:briefs`/`briefs:validate`. App routes are split into `(public)` and `(app)` route groups; auth is gated per-request by `apps/web/proxy.ts` (Next 16's renamed middleware) plus a Suspense-wrapped `requireUser()` in `(app)/layout.tsx`. Internal jobs live under `/api/internal/jobs/*` (`tick`, `lock-rounds`, `run-rounds`, `settle-rounds`, `rejudge`, `sol`), gated by `INTERNAL_JOB_SECRET`; live round progress is `GET /api/rounds/[id]/progress`. Rounds advance without an operator: `apps/web/instrumentation.ts` starts an in-process scheduler (`lib/server/services/automation/`) that locks due rounds, runs the pipeline, settles and pays out, with `ROUND_SCHEDULER=off` to disable and the `tick` endpoint as the manual twin. The F31 judge is complete: it is resolved by role, stores a weighted per-criterion ruling, and can be re-run on stored frames via `POST /api/internal/jobs/rejudge` without re-generating code. Detailed requirements and build order live in `REQUIREMENTS.md` (decisions log, milestones M0–M7, open items); follow that ordering when implementing.

## Non-negotiable constraints

- **Devnet SOL only (revised 2026-11-20).** SOL rounds wager valueless Devnet test SOL. Mainnet transfers and real-money wagering, deposits or payouts stay blocked pending legal and security review. The Solana module refuses any non-Devnet RPC by genesis hash.
- **Never execute LLM-generated code on the application server.** All evaluation runs in an isolated sandbox with CPU/memory/time limits and no network/filesystem access.
- **Browser-rendered generated code is quarantined.** A viewer-facing render runs in an iframe with `sandbox="allow-scripts"` and **never** `allow-same-origin`, `srcdoc` with a CSP of `connect-src 'none'`, and no access to the app origin, cookies or storage.
- **The windows hold (revised 2026-11-20).** SOL rounds: ante until `prediction_deadline`; live wagers during generation; betting closes before any output past the first model's 75% token mark, any finish/failure, final render, gate result or verdict is visible ("close, then publish"). Votes and judge verdicts are refused until betting closes. The crowd vote never moves SOL; tied winners split by dead heat. Points rounds keep the original two clocks.
- **API credentials stay server-side** — LLM provider keys, DB credentials, and any evaluator secrets must never reach the client bundle.
- **Solana Devnet** for all blockchain interaction during development.
- Consumer UX first: users must not need blockchain knowledge to use the product.
- The whole demo must run reliably end-to-end in 2–3 minutes (hackathon demo video requirement).

## What Solana does vs. what it doesn't

Scope is decided (G1, 2026-11-19) — full record in
`docs/solana-integration.md`. The transport is **SPL Memo transactions on
Devnet**; there is no custom program.

On-chain (Solana): prediction commitments (hashes), signed by the user's wallet;
competition IDs and deadlines; a settlement record. These are **records**, not
enforcement — the deadline is enforced by the database and the backend, and the
chain only proves a commitment existed before it. Anchor with program-enforced
deadlines is the documented upgrade path, not the current shape.

Off-chain (PostgreSQL): user data, generated code, test results, large datasets, private information, the commitment nonce, and the points ledger.

Blockchain verification guarantees that commitments existed before the deadline and were not altered. It does **not** verify that model execution or scoring was honest, that the judge was impartial, or that a commitment backed a stake that actually counted in the pool — those still depend on the trusted backend. Devnet is disposable, so these are demo-grade guarantees. Document this distinction in any user-facing or judge-facing material.

## Accounts, wallets, and the join gate

- Identity comes from Supabase auth. Sign in with Solana produces a
  wallet-identified account; email sign-up prompts a one-time wallet link and
  otherwise continues in practice mode.
- An email user's wallet link is a `public.wallets` row, not an auth identity —
  supabase-js cannot attach a Web3 identity to an existing email user.
- `public.users.funded` is **derived**: true exactly when a `public.wallets` row
  exists, maintained by trigger. Clients hold no grant on it, so nothing can
  promote itself. `practice_mode` is self-service because it can only reduce
  access.
- **Rounds are created by the admin/server side. Users never create rounds;
  they join them.** Only a funded account not in `practice_mode` joining starts
  a prompt session. Practice accounts browse and observe.
- No money moves in the MVP. "Funded" marks eligibility to add funds later and
  does not mean a deposit was made.

## Competition lifecycle (state machine)

`CREATED → OPEN → LOCKED → RUNNING → EVALUATING → SETTLED → ARCHIVED`, plus failure/cancel/retry states.

Rules that must hold in code:

- Predictions accepted only in `OPEN`; late or duplicate submissions rejected at the API and database level. In the current memo-only scope the chain does **not** reject anything — it records a hash and proves its timing.
- State transitions are one-directional and validated — no invalid jumps, no modifications to finalized (`SETTLED`/`ARCHIVED`) results.
- Scoring runs idempotently — interrupted settlement must not double-score.
- Defined behavior for: model API failure, execution failure, ties, all-models-failing, blockchain tx failure, interrupted settlement.

## Scoring rules

Two independent outcomes per round — never conflate them.

- **Conformance** (objective): deterministic checks (process ran, no uncaught
  error, the brief's required frame count and dimensions) plus a **judge model**
  (`llm_models` row with `role = 'judge'`, a vision model) ruling on whether
  the frames follow the brief. A model failing the deterministic checks is
  `forfeited` and is never eligible for fan-favorite points.
- **Best** (subjective): the crowd vote, opened only after `LOCKED`. Voting
  changes nothing about conformance.

Production rules that still apply: frames are captured at explicit time steps
(never wall-clock) so renders are reproducible; the same pinned container image
judges every run.

## Locked stack decisions

- **Auth + DB**: Supabase all-in-one (Postgres + auth + RLS). Login-first via email/password or Sign in with Solana (Phantom, the social provider) — decided 2026-11-18 since the product is Solana-native. On-chain commitment verification still needs the wallet; it is no longer merely an optional link.
- **LLM access**: OpenRouter — one integration, model IDs in config. Lineup: the cheapest three capable models, chosen at config time. Concretely: active rows in `llm_models` ordered by `sort_order`; `OPENROUTER_API_KEY` (plus optional `OPENROUTER_*` tuning) is the only secret.
- **Sandbox**: fresh Docker container per evaluation run (`--network-none`, CPU/memory/time limits), deployed on a container-capable host (Fly.io / Railway / Render) — not Vercel.
- **Challenges**: a hand-seeded **visual brief** bank for the MVP; a generation pipeline may expand it, but briefs are never generated live mid-competition.
- **Renderer**: three.js/Canvas code written by the models. The container renders frames with headless Chromium (judging); the viewer replays the same code in a quarantined iframe. Blender is a flagged later challenge type — its render times do not fit the demo.
- **Prediction**: parimutuel points pool on the conformance outcome; stake before the deadline, pot splits among backers of the winner. Non-redeemable points only.
- **Rewards**: points / leaderboard only. No tokens, no NFTs, no real money.

## Interface system

The web app has a committed design system; do not restyle pages ad hoc.

- Visual authority: `apps/web/DESIGN.md` (built system) plus
  `apps/web/.impeccable/design.json` (tokens). Product truth:
  `apps/web/PRODUCT.md`.
- Tokens live in `apps/web/app/globals.css` as Tailwind v4 `@theme`
  variables plus a `:root` block. Use them (`bg-void`, `text-ink`,
  `text-muted`, `text-faint`, `border-hairline`, `text-magenta`,
  `text-violet`); never raw `zinc-*`/`blue-*` classes.
- Shared primitives live in `apps/web/components/ui.tsx`; icons are
  authored SVGs in `components/icons.tsx`, never font glyphs.
- The world is dark-only. Status is a 6px dot plus a word, never a filled
  colour chip, and selection must be legible without colour.
- The hero is a three.js flow field (`components/vortex-field.tsx`). Keep
  its `prefers-reduced-motion` still frame, its CSS underlay fallback,
  and its off-screen pause.
- Copy carries the post-pivot vocabulary — brief, render, conformance,
  crowd vote, stake. The retired accuracy / speed / code-length wording
  must not return.
- Demo data on the landing page is labelled synthetic. Never add
  fabricated users, win rates, testimonials or benchmarks.

## Architecture boundaries

Keep frontend, business logic, and external integrations decoupled. Backend services: auth/user management, competition management, challenge management, prediction management, LLM orchestration, code evaluation/sandboxing, scoring/settlement, blockchain integration.

- **LLM integration**: identical brief, chunking policy and token cap for every model; record exact model identifier + config; handle timeouts/failures/unavailable models explicitly; store generated code, rendered artifacts and execution metadata.
- **Database**: Supabase Postgres. Core entities: Users, Wallets, LLM Models, Briefs (formerly Challenges), Competition Rounds, Predictions (now stakes), Model Executions, Rendered Artifacts (replacing Test Results), Competition Results, User Scores, Blockchain Transactions.

## Development priorities

- **P0 (hackathon slice — see REQUIREMENTS.md)**: one seeded visual brief, three models, chunked generation streamed to the viewer, progressive render, deterministic checks + judge ruling, crowd vote, and one meaningful Solana Devnet interaction (a stake commitment).
- **P1 (post-submission, in order)**: parimutuel pool settlement and live odds; encrypted stakes; leaderboards and prediction history; Blender challenge type behind a flag.
- **P2**: more renderer types, tournament formats, more providers, social/achievements, real-money (gated on legal/security review).

Prefer simple, reliable solutions over abstractions. The hackathon window is short — prioritize a working end-to-end product.

## Hackathon deliverables

Public GitHub repo, architecture documentation + README, deployed working demo, 2–3 minute demo video. The demo must show: meaningful blockchain interaction, a clear consumer use case, and intuitive UX.

## Open decisions (see REQUIREMENTS.md for full list)

1. Final three competitor model IDs **and** the judge (vision) model ID on OpenRouter.
2. Deployment host: Fly.io vs Railway vs Render (must run Docker and headless Chromium).
3. Points formula: pot split plus fan-favorite award, and starter grants for new accounts. Demo rounds stay admin-triggered.
4. Whether the crowd vote is weighted by stake or one-person-one-vote.

**Resolved:** Solana scope (G1) — lightweight user-signed SPL Memo commitments on
Devnet, operator-signed round and settlement records, no custom program. Anchor
is the post-submission upgrade. See `docs/solana-integration.md`.

## Known hazards of the pivot

- **Partial chunks usually will not run.** A half-written scene throws. The
  progressive render must degrade to showing code growth rather than failing
  the round (F17).
- **Browser execution of generated code is a real attack surface.** The
  quarantine rules above are not optional.
- **Blender does not fit the demo budget.** Headless Blender is minutes per
  clip; the 2–3 minute requirement rules it out for the submission.
