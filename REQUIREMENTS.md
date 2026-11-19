# AI Showdown — Requirements & Build Order

Last updated: 2026-11-19. Source: project spec + decisions confirmed with the team.

## Pivot notice (2026-11-19)

The competition format changed. Original plan: standardized Python coding
challenges judged on correctness, speed and code length — a LeetCode with
LLMs. That reads as homework, not entertainment, and the three categories
carry no drama.

**New direction: a live visual showdown.** Models are given a creative brief
(e.g. "an isometric donut spinning in a loop", "a pulsing reactor core") and
write code that produces a **render** — a frame sequence or a live scene. The
work is shown **as it is written**: code streams in chunks, and each finished
chunk renders so the audience watches the artifact take shape.

The judging split matches what is actually objective and what is actually fun:

- **Conformance** is measured — deterministic checks (it runs, it does not
  throw, it produces frames) plus a **judge model** ("Jev") that sees the
  frames and rules on whether the output follows the brief.
- **"Best" is subjective** — the crowd decides.

Prediction is kept, but only as a **sealed bet placed before anything runs**.
A crowd vote that is also the thing being bet on is not a prediction; it is a
free point. The two clocks below are the rule that makes this coherent.

## Decisions Log

| Area                    | Decision                                                                                                                                                                                                                                                                     | Status     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Auth + DB               | Supabase all-in-one (Postgres + auth + RLS)                                                                                                                                                                                                                                  | **Locked** |
| LLM access              | OpenRouter (single integration, model IDs in config)                                                                                                                                                                                                                         | **Locked** |
| Code sandbox            | Docker container per evaluation run, on a container-capable host — `--network-none`, CPU/memory/time limits                                                                                                                                                                  | **Locked** |
| Challenge source        | Hand-seeded **visual brief bank** for MVP; generation pipeline may expand it later, never live mid-competition                                                                                                                                                               | **Locked** |
| LLM lineup              | Cheapest three capable models on OpenRouter, active rows in `llm_models`; run cost kept near zero during testing                                                                                                                                                             | **Locked** |
| Judge model             | A separate OpenRouter **vision** model (working name "Jev"), configured as a `llm_models` row with `role = 'judge'` — never a hard-coded ID                                                                                                                                  | **Locked** |
| Rewards                 | Points / leaderboard only. No tokens, no NFTs, no real money                                                                                                                                                                                                                 | **Locked** |
| Auth flow               | Login-first via Supabase: email/password, plus Sign in with Solana (Phantom) as the social provider                                                                                                                                                                          | **Locked** |
| Wallet ↔ account model  | A Solana sign-in creates a wallet-identified account; email users may link a wallet or continue in practice mode                                                                                                                                                             | **Locked** |
| "Funded" account        | Derived: funded exactly when a `public.wallets` row exists. No money moves                                                                                                                                                                                                   | **Locked** |
| Who creates rounds      | Admin/server side only. Users never create rounds; they join them                                                                                                                                                                                                            | **Locked** |
| **Competition format**  | **Visual brief → generated render**, streamed and rendered progressively. Replaces test-case coding challenges (2026-11-19)                                                                                                                                                  | **Locked** |
| **Correctness signal**  | **Deterministic checks** (runs / no throw / frames emitted) **+ judge model** conformance ruling. No hidden expected-output tests                                                                                                                                            | **Locked** |
| **"Best" signal**       | **Crowd vote**, opened only after betting has closed                                                                                                                                                                                                                         | **Locked** |
| **Prediction mechanic** | **Parimutuel points pool** on the conformance outcome: stake points on a model before the round runs; the pot splits proportionally among backers of the winner. Points only, non-redeemable                                                                                 | **Locked** |
| **Renderer (MVP)**      | Model writes **three.js / Canvas** code. Container renders frames with headless Chromium for the judge; the viewer plays the same code live in a sandboxed iframe. **Blender is a flagged, later challenge type** — headless Blender render times do not fit the demo budget | **Locked** |
| **Live presentation**   | Chunked generation with a per-chunk token cap; each finished chunk renders, then generation continues. Code is visible while it is written                                                                                                                                   | **Locked** |
| Solana scope            | Deferred — commitments (G1) is the recommended shape: on-chain pool + commitment hashes + settlement record                                                                                                                                                                  | **Gated**  |
| Frontend stack          | Next.js (TypeScript) + Tailwind                                                                                                                                                                                                                                              | **Locked** |
| App packaging           | Production Dockerfile at repo root (Next.js standalone output); deploy host still open                                                                                                                                                                                       | **Locked** |

## The two clocks (non-negotiable)

This is what keeps prediction meaningful.

1. **Betting window** — `OPEN` until `prediction_deadline`. Users stake points
   on a model. Each stake is committed on-chain as
   `hash(pick, stake, nonce)` (F20). Nobody has seen a render yet.
2. **Reveal and vote** — at the deadline the round locks and runs. Only then
   do renders exist and the crowd vote opens.

A prediction placed after the outcome is visible is provably impossible: the
on-chain commitment predates the deadline. That property is the reason the
prediction mechanic is worth keeping, and it is the thing to say on camera.

**Internal invalidation.** While the round is running, the safety rail is the
**encrypted order book**, not the frontend. Stakes are submitted encrypted
(so the mempool cannot front-run the running commentary) and decrypted at
close. Design rule: `SUBMIT` accepts only encrypted payloads; plaintext
stakes are rejected. Earmarked follow-up — not in the hackathon slice.

## Non-Negotiable Constraints

1. No real-money wagering, deposits, or payouts. Stake points only; the pool
   is a points redistribution, not a market.
2. LLM-generated code never executes on the application server — only inside
   the sandbox.
3. API credentials (OpenRouter, Supabase service role, etc.) remain server-side.
4. Solana Devnet only during development.
5. Users must be able to participate without any blockchain knowledge.
6. The end-to-end flow must demo reliably in 2–3 minutes.
7. **Renders must be reproducible**: the same generated code in the same
   pinned container yields the same frames. Frame capture uses explicit time
   steps, never wall-clock.
8. **Browser-rendered code is quarantined**: an iframe with
   `sandbox="allow-scripts"` and **never** `allow-same-origin`, `srcdoc` with a
   CSP of `connect-src 'none'`, no access to app origin, cookies, or storage.
   Generated code may run in a viewer's browser only under these rules.
9. A model must pass the deterministic checks to qualify for judging; a
   forfeit never silently becomes "last place with points".
10. **Every model receives the identical brief and the identical chunking
    policy.** Chunk size, token cap and instruction text are part of the
    recorded config.

## Functional Requirements (build order)

### M0 — Foundations

- F1. Monorepo scaffold: Next.js (TS) app, shared types package, ESLint/Prettier, env-based config. **Done (2026-11-18)**
- F2. Supabase project + schema migrations (FKs, constraints, indexes). **Done (2026-11-18)**
- F3. Structured logging + consistent error-handling convention. **Done (2026-11-18)**

### M1 — Accounts & Shell

- F4. Supabase auth (email/password + Sign in with Solana via Phantom), session handling, protected routes. **Done (2026-11-18)**
- F5. App shell: landing page + logged-in dashboard layout. **Done (2026-11-18)**
- F6. User profile record sync, points balance display. **Partial (2026-11-18)** — points are read client-side from `user_scores`; the server-authoritative read plugs into `requireUser()`.

### M2 — Competitions & Predictions

Still valid. The lifecycle, join gate and deadline enforcement are unchanged;
only what users predict changes (a model, with a stake, instead of three
categories).

- F7. Competition lifecycle state machine: `CREATED → OPEN → LOCKED → RUNNING → EVALUATING → SETTLED → ARCHIVED` + failure/cancel/retry states. **Done (2026-11-19)** — merged via #36.
- F8. Admin/internal path to create a round (brief, participating models, prediction deadline).
- F9. Dashboard lists open rounds: brief preview, models, deadline countdown, live pool odds.
- F10. Prediction submission: stake points on a model; server-side validation rejects late, duplicate or over-balance stakes. Only funded, non-practice accounts join live. **Enforcement gap:** M1 ships this as UI copy and a derived `funded` column only — the join endpoint must reject unfunded/practice accounts at the API layer, and RLS must scope inserts.
- F11. Lock predictions at the deadline (transition to `LOCKED`), idempotent, survives restarts. **Done (2026-11-19)** — migration `20261118101400` adds `public.lock_due_rounds(now, limit, reason)`, which locks every due `OPEN` round in one transaction using `for update skip locked` and the existing audited `transition_round` RPC (repeat of target status = no-op). `services/competitions/lock.ts` wraps it (`lockDueRounds`, `listRoundsAwaitingRun` for restart-safe F17 pickup); `POST /api/internal/jobs/lock-rounds` is the trigger, gated by `INTERNAL_JOB_SECRET` (fails closed). This is the "betting window" clock in the two-clocks rule: it closes stakes before any render exists. Unit tests in `lock.test.ts`; SQL assertions in `supabase/tests/constraints.sql`.

### M3 — Visual Challenge Bank & Sandbox _(re-scoped 2026-11-19)_

- F12. **Seeded visual brief bank**: brief text, style constraints, target
  render duration, deterministic check definitions, judge rubric, starter
  snippet. Each brief is versioned and must be validated (runs a reference
  implementation) before `published`. **Re-scoped** from the Python
  test-case bank. _Former scope: prompt + hidden expected-output tests._
- F13. **Sandbox runner**: fresh Docker container per run — no network, CPU/
  memory limits, wall-clock timeout, read-only FS where possible. Now emits
  **artifact frames** (image files) instead of test values, via headless
  Chromium. The host-side trust boundary, stream parsing and persistence are
  unchanged. **In progress (2026-11-19)**
- F14. **Artifact evaluation** _(replaces correctness/speed/length)_:
  deterministic checks (process exit, no uncaught error, N frames produced,
  frame dimensions match the brief), then judge-model conformance scoring on
  captured frames. Speed and code-length categories are **removed**.
- F15. **Failure, tie and void behavior**: render error or timeout = forfeit;
  judge cannot see frames = `unavailable`; all models forfeit = round voided;
  ties at equal conformance resolved by the crowd's fan-favorite pool.

### M4 — LLM Orchestration, Judging & Settlement _(re-scoped 2026-11-19)_

- F16. OpenRouter client: identical prompt + eval instructions to all models; records exact model ID, config, latency; handles timeout/unavailability (retry policy, model forfeit after N failures). **Done (2026-11-19)** — `apps/web/lib/server/integrations/openrouter/client.ts` returns typed outcomes (timeout, network, rate limited, provider error, unavailable model, auth, credits, invalid request, malformed response) and retries transient failures up to 3 attempts with backoff; the lineup comes from active `llm_models` rows; `services/llm/generate.ts` writes `model_executions` with the model/params snapshot, prompt-template version + hash, latency, per-attempt diagnostics and `failure_kind`, and marks a model forfeited at the failure threshold. Unit tests via Vitest; live call test gated behind `OPENROUTER_API_KEY`. Final model IDs remain open item 2 (a `llm_models` seed).
- F17. **Chunked orchestration pipeline**: after `LOCKED`, reveal the brief →
  stream generation in capped chunks → render each finished chunk → run
  deterministic checks → invoke the judge model → store frames, judge
  verdicts and executions. Must degrade when a partial chunk does not parse
  (show growth, do not fail the round).
- F31. **Judge model integration** _(new, 2026-11-19)_: a vision-capable
  OpenRouter model configured as a `llm_models` row with `role = 'judge'`;
  given the brief and sampled frames, returns a structured conformance
  verdict (pass/fail and reason per criterion). Same client and retry/forfeit
  rules, separate `run_type = 'judge'` rows.
- F18. **Parimutuel scoring & settlement** _(re-scoped 2026-11-19)_: compute
  the pool, resolve the conformance outcome, split the pool proportionally
  among backers of the winning model, and award fan-favorite points.
  Idempotent — interrupted settlement never double-pays. _Former scope:
  category winners + point awards._
- F19. **Results + replay view** _(re-scoped)_: side-by-side rendered
  artifacts, playback of each model's code and frames, per-model conformance
  verdict, why each model forfeited, and final odds vs. outcome.
- F32. **Crowd voting** _(new, 2026-11-19)_: opens only after `LOCKED`; one
  vote per funded account per round; tallies into the fan-favorite result that
  F18 settles. Voting never affects the conformance outcome.

### M5 — Solana Integration (scope gated)

- G1. **Decide scope** before this milestone. Recommended: commitments on the
  pool (stake hashes), round deadlines, and settlement records — not a
  full on-chain market.
- F20. Stake commitments on Devnet: `hash(pick, stake, nonce)` per stake,
  verify-on-demand for linked wallets.
- F21. Record round IDs and deadlines on-chain.
- F22. Settlement/achievement records on-chain (pot size, payout distribution).
- F23. Honest guarantees documentation: the chain proves a stake existed
  before the deadline and paid out as recorded. It does **not** prove the
  models ran honestly or that the judge was impartial — the backend is still
  trusted.

### M6 — Leaderboards & History (Priority 1)

- F24. User leaderboard (points, streaks, prediction hit rate).
- F25. Historical model performance across rounds (conformance rate, crowd
  win rate).
- F26. User prediction history (stake vs outcome).
- F27. Live round progress: code streaming, renders appearing, odds moving.

### M7 — Deploy & Demo

- F28. Deployment: Next.js frontend + backend on a container-capable host
  (sandbox and headless Chromium run alongside), Supabase hosted, Solana
  Devnet.
- F29. README + architecture documentation (incl. F23 guarantees note and the
  quarantine rules for browser-rendered code).
- F30. 2–3 minute demo video; rehearsed flow (sign up → stake before deadline →
  watch code and renders → vote → settlement).

## Hackathon slice (deadline 2026-11-20, 12:00 PM CST)

The pivot is larger than one day. This section is the honest cut.

**Must have for the demo**

1. One seeded visual brief, one renderer (three.js/Canvas), three models.
2. Chunked generation with a token cap, streamed to the viewer.
3. Progressive render of finished chunks (graceful when a chunk does not
   parse).
4. Deterministic checks + judge model ruling.
5. Crowd vote for "best".
6. At least one meaningful Solana interaction: a stake commitment on Devnet.

**Post-submission roadmap (in order)**

1. Parimutuel pool settlement and live odds.
2. Encrypted stakes (invalidating the running commentary).
3. Leaderboards and prediction history.
4. Blender-based challenges, behind a feature flag.
5. Live round progress polish.

Anything not listed above is out of scope for the submission.

## Non-Functional Requirements

- Type-safe interfaces end-to-end (TypeScript types shared between
  frontend/backend; validated API inputs).
- Reproducible evaluation: same code + same brief + same pinned image → same
  frames.
- Idempotency for all settlement/scoring paths.
- Authorization enforced at the database level (RLS) and API level.
- Secrets via environment configuration only; never in client bundles.

## Out of Scope (MVP)

- Multiple programming languages (models write JavaScript for the browser,
  and Python only where Blender is enabled later).
- Real-money wagering, deposits, payouts, transferable tokens.
- Advanced tournament formats, social features, achievement NFTs.
- LLM-generated briefs during a live competition.
- Mobile app.

## Remaining Open Items

1. **G1 — Solana scope** (blocks M5; decide before M5 starts).
2. Final three competitor model IDs, plus the judge model ID (vision-capable),
   on OpenRouter.
3. Deployment host: Fly.io vs Railway vs Render (all support the Docker
   sandbox requirement; headless Chromium adds memory).
4. Points formula: pot split plus fan-favorite award, and starter point
   grants for new accounts.
5. Round cadence for the demo (admin-triggered, as before).
6. Whether the crowd vote is weighted by stake or one-person-one-vote.
