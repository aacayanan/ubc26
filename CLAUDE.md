# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**AI Showdown** — a live visual showdown where LLMs are given a creative brief (a spinning donut, a pulsing reactor core) and write code that **renders**. The audience watches the code stream in chunks and the artifact take shape. **Conformance** (does it run, does it follow the brief) is decided by deterministic checks plus a vision judge model; **"best"** is decided by the crowd. Users stake points on a model _before_ the deadline via a **parimutuel pool** — sealed on-chain, so the prediction cannot be hindsight. Built for the UBC 2026 Hackathon, Track 03 (Consumer Applications), on Solana Devnet. Submission deadline: **November 20, 2026, 12:00 PM CST**.

**Pivot (2026-11-19):** this replaced the original plan of standardized Python coding challenges judged on accuracy/speed/code length. That format read as LeetCode homework. Speed and code-length categories are gone; challenges are now visual briefs. See the pivot notice at the top of `REQUIREMENTS.md`.

Repo state: monorepo scaffolded 2026-11-18, M0 done and M1 accounts/shell done (F4, F5 shipped; F6 profile sync partial), F7 lifecycle and F11 deadline locking done (merged), M3 sandbox runner (F13) landed, F12's visual brief bank seeded and validated (Chromium render sandbox, versioned seeds, publish gate), M4's OpenRouter client (F16) merged, and the F17 chunked pipeline landed with the minimal F31 judge it depends on (2026-11-19) — Next.js app in `apps/web`, shared types in `packages/shared`, lint/format tooling, production Dockerfile (standalone output), Supabase schema in `supabase/migrations/` (all core entities, constraints, RLS policies, profile-sync trigger, `transition_round`/`lock_due_rounds`/`seed_brief`/`publish_brief` RPCs) with assertion tests in `supabase/tests/` and CLI scripts `db:link`/`db:push`/`db:seed:briefs`/`briefs:validate`. App routes are split into `(public)` and `(app)` route groups; auth is gated per-request by `apps/web/proxy.ts` (Next 16's renamed middleware) plus a Suspense-wrapped `requireUser()` in `(app)/layout.tsx`. Internal jobs live under `/api/internal/jobs/*` (`lock-rounds`, `run-rounds`), gated by `INTERNAL_JOB_SECRET`; live round progress is `GET /api/rounds/[id]/progress`. Detailed requirements and build order live in `REQUIREMENTS.md` (decisions log, milestones M0–M7, open items); follow that ordering when implementing.

## Non-negotiable constraints

- **No real-money wagering, deposits, or payouts** without an explicit product decision. The parimutuel pool redistributes non-redeemable points only.
- **Never execute LLM-generated code on the application server.** All evaluation runs in an isolated sandbox with CPU/memory/time limits and no network/filesystem access.
- **Browser-rendered generated code is quarantined.** A viewer-facing render runs in an iframe with `sandbox="allow-scripts"` and **never** `allow-same-origin`, `srcdoc` with a CSP of `connect-src 'none'`, and no access to the app origin, cookies or storage.
- **The two clocks hold.** Stakes close before any render exists; the crowd vote opens only after `LOCKED`. Never let a vote or a visible outcome precede the betting deadline.
- **API credentials stay server-side** — LLM provider keys, DB credentials, and any evaluator secrets must never reach the client bundle.
- **Solana Devnet** for all blockchain interaction during development.
- Consumer UX first: users must not need blockchain knowledge to use the product.
- The whole demo must run reliably end-to-end in 2–3 minutes (hackathon demo video requirement).

## What Solana does vs. what it doesn't

On-chain (Solana): prediction commitments (hashes), competition IDs and deadlines, deadline enforcement, verifiable prediction history, settlement/achievement records.

Off-chain (PostgreSQL): user data, generated code, test results, large datasets, private information.

Blockchain verification guarantees that commitments existed before the deadline and were not altered. It does **not** verify that model execution or scoring was honest — that still depends on the trusted backend. Document this distinction in any user-facing or judge-facing material.

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

- Predictions accepted only in `OPEN`; late or duplicate submissions rejected at both API and (where possible) on-chain level.
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

1. Solana scope (gated — decide before M5): Anchor program with commitments + deadline enforcement vs. lightweight tx records vs. full on-chain. Recommended: an on-chain points pool with stake commitments and a settlement record, not a full on-chain market.
2. Final three competitor model IDs **and** the judge (vision) model ID on OpenRouter.
3. Deployment host: Fly.io vs Railway vs Render (must run Docker and headless Chromium).
4. Points formula: pot split plus fan-favorite award, and starter grants for new accounts. Demo rounds stay admin-triggered.
5. Whether the crowd vote is weighted by stake or one-person-one-vote.

## Known hazards of the pivot

- **Partial chunks usually will not run.** A half-written scene throws. The
  progressive render must degrade to showing code growth rather than failing
  the round (F17).
- **Browser execution of generated code is a real attack surface.** The
  quarantine rules above are not optional.
- **Blender does not fit the demo budget.** Headless Blender is minutes per
  clip; the 2–3 minute requirement rules it out for the submission.
