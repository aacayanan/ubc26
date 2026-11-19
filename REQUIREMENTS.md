# AI Showdown — Requirements & Build Order

Last updated: 2026-11-18. Source: project spec + decisions confirmed with the team.

## Decisions Log

| Area                   | Decision                                                                                                                                                                                                                                                                                           | Status     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Auth + DB              | Supabase all-in-one (Postgres + auth + RLS)                                                                                                                                                                                                                                                        | **Locked** |
| LLM access             | OpenRouter (single integration, model IDs in config)                                                                                                                                                                                                                                               | **Locked** |
| Code sandbox           | Docker container per evaluation run, on a container-capable host (Fly.io / Railway / Render) — `--network-none`, CPU/memory/time limits                                                                                                                                                            | **Locked** |
| Challenge source       | Hybrid: hand-seeded bank for MVP; generation pipeline to expand the bank later (never generated live mid-competition)                                                                                                                                                                              | **Locked** |
| LLM lineup             | Cheapest three capable models on OpenRouter, chosen at config time; run cost kept near zero during testing                                                                                                                                                                                         | **Locked** |
| Rewards                | Points / leaderboard only. No tokens, no NFTs, no real money                                                                                                                                                                                                                                       | **Locked** |
| Auth flow              | Login-first via Supabase: email/password, plus Sign in with Solana (Phantom) as the social provider. Decided 2026-11-18 — the product is Solana-native, so the wallet is a first-class identity rather than an optional link                                                                       | **Locked** |
| Wallet ↔ account model | A Solana sign-in creates a wallet-identified account. Email users may link a wallet through a first-run step, or skip into practice mode. Linking writes a `public.wallets` row; it does not re-key the auth identity (supabase-js has no API to attach a Web3 identity to an existing email user) | **Locked** |
| "Funded" account       | Derived, not administered: an account is funded exactly when it has a `public.wallets` row. No money moves — the flag marks eligibility to add funds later and to start live prompt sessions                                                                                                       | **Locked** |
| Who creates rounds     | Admin/server side only. Users never create rounds; they join them. A funded, non-practice account joining is what starts a prompt session                                                                                                                                                          | **Locked** |
| Solana scope           | Deferred — decide between Anchor program / lightweight tx records / full on-chain before Milestone 5 starts                                                                                                                                                                                        | **Gated**  |
| Frontend stack         | Next.js (TypeScript) + Tailwind — confirmed at scaffold time                                                                                                                                                                                                                                       | **Locked** |
| App packaging          | Production Dockerfile at repo root (Next.js standalone output); deploy host still open                                                                                                                                                                                                             | **Locked** |

## Non-Negotiable Constraints

1. No real-money wagering, deposits, or payouts. Points only.
2. LLM-generated code never executes on the application server — only inside the sandbox.
3. API credentials (OpenRouter, Supabase service role, etc.) remain server-side.
4. Solana Devnet only during development.
5. Users must be able to participate without any blockchain knowledge.
6. The end-to-end flow must demo reliably in 2–3 minutes.
7. Code-length counting normalizes formatting first; speed benchmarking uses fixed, reproducible conditions.
8. A model must pass all correctness tests to qualify for speed or code-length wins.

## Functional Requirements (build order)

### M0 — Foundations

- F1. Monorepo scaffold: Next.js (TS) app, shared types package, ESLint/Prettier, env-based config. **Done (2026-11-18)** — includes a production Dockerfile (standalone build) and `.dockerignore`.
- F2. Supabase project + schema migrations: Users, Wallets, LLM Models, Challenges, Competition Rounds, Predictions, Model Executions, Test Results, Competition Results, User Scores, Blockchain Transactions (FKs, constraints, indexes). **Done (2026-11-18)** — 10 ordered migrations in `supabase/migrations/` (FKs, uniqueness/check constraints, indexes, timestamps, RLS policies, plus profile sync and derived funding status); assertion scripts in `supabase/tests/` verified against a fresh hosted project; service-role key documented in README and `.env.example`.
- F3. Structured logging + consistent error-handling convention from the first commit. **Done (2026-11-18)** — typed application errors, structured redacted logs, correlation IDs, shared API/background wrappers, and a consistent API error response shape are implemented in `apps/web/lib/server/`.

### M1 — Accounts & Shell

- F4. Supabase auth (email/password + Sign in with Solana via Phantom), session handling, protected routes. **Done (2026-11-18)** — `apps/web/proxy.ts` refreshes the session cookie and gates `/dashboard`, `/predictions`, `/profile`, `/link-wallet` to `/login?next=`; `app/(app)/layout.tsx` adds a Suspense-wrapped `requireUser()` check as defence in depth. Provider secrets live in the Supabase dashboard; only `NEXT_PUBLIC_SUPABASE_URL`/`_PUBLISHABLE_KEY` reach the bundle.
- F5. App shell: landing page + logged-in dashboard layout. **Done (2026-11-18)** — landing page with a jargon-free 3-step explainer; `(public)`/`(app)` route groups with a shared header, mobile nav, and active-link states; dashboard renders explicit loading, empty, and error states.
- F6. User profile record sync (Supabase auth → Users table), points balance display (starts at 0). **Partial (2026-11-18)** — migration `20261118100900` creates the `public.users` row from an `on_auth_user_created` trigger for every signup path, plus a backfill and the `practice_mode`/`funded` columns. Still open: points are read client-side from `user_scores` and show zeros; the server-authoritative read plugs into `requireUser()`.

### M2 — Competitions & Predictions

- F7. Competition lifecycle state machine: `CREATED → OPEN → LOCKED → RUNNING → EVALUATING → SETTLED → ARCHIVED` + failure/cancel/retry states, validated one-way transitions, no edits after `SETTLED`.
- F8. Admin/internal path to create a competition round (challenge, participating models, prediction deadline).
- F9. Dashboard lists open competitions: challenge preview, models, deadline countdown, potential points.
- F10. Prediction submission UI: pick a winner per category (accuracy, speed, code length); server-side validation rejects late/duplicate submissions. Joining a round starts a prompt session, and only funded accounts (linked Solana wallet, not in practice_mode) may join live; practice accounts browse and observe. **Enforcement gap:** M1 ships this rule as UI copy and a derived `funded` column only — the join endpoint must reject unfunded/practice accounts at the API layer, and RLS must scope inserts, when this lands.
- F11. Prediction locking at deadline (transition to `LOCKED`), idempotent, survives restarts.

### M3 — Challenge Bank & Sandbox

- F12. Seeded challenge bank: prompt text, starter code, public + hidden test cases; hand-validated before use.
- F13. Sandbox service: fresh Docker container per run — no network, CPU/memory limits, wall-clock timeout, read-only FS where possible; captures stdout/stderr, exit code, runtime.
- F14. Evaluation engine: correctness (test pass rate), speed (repeated runs, warm-up, fixed environment), code length (format-normalized, consistent counting rule).
- F15. Failure handling: execution error/timeout = category forfeit; ties share placement; all-models-fail = round voided per defined rule.

### M4 — LLM Orchestration & Scoring

- F16. OpenRouter client: identical prompt + eval instructions to all models; records exact model ID, config, latency; handles timeout/unavailability (retry policy, model forfeit after N failures).
- F17. Orchestration pipeline: after `LOCKED`, reveal challenge → call models → sandbox each solution → evaluate → store executions + test results.
- F18. Scoring & settlement: determine category winners (correctness gates speed/length), score user predictions, award points; idempotent — interrupted settlement never double-scores.
- F19. Results view: winning solutions side-by-side, per-category metrics, why each model won/forfeited.

### M5 — Solana Integration (scope gated)

- G1. **Decide scope** before this milestone: (a) Anchor program with competition accounts + hashed prediction commitments + on-chain deadline enforcement, (b) lightweight memo/tx commitment records, or (c) full on-chain predictions/settlement (not recommended for the timeline).
- F20. Prediction commitments on Devnet (form depends on G1); verify-on-demand for users who linked a wallet.
- F21. Record competition IDs and deadlines on-chain (form depends on G1).
- F22. Settlement/achievement records on-chain (form depends on G1).
- F23. Honest guarantees documentation: chain proves commitment existence before deadline; scoring honesty depends on the backend. State this in README and UI.

### M6 — Leaderboards & History (Priority 1)

- F24. User leaderboard (points, streaks).
- F25. Historical LLM performance across rounds.
- F26. User prediction history (picks vs outcomes).
- F27. Live competition progress display during `RUNNING`/`EVALUATING`.

### M7 — Deploy & Demo

- F28. Deployment: Next.js frontend + backend on a container-capable host (sandbox runs alongside), Supabase hosted, Solana Devnet.
- F29. README + architecture documentation (incl. F23 guarantees note).
- F30. 2–3 minute demo video; rehearsed end-to-end flow (signup → predict → lock → run → results).

## Non-Functional Requirements

- Type-safe interfaces end-to-end (TypeScript types shared between frontend/backend; validated API inputs).
- Reproducible evaluation: same solution + same challenge → same verdict under fixed sandbox conditions.
- Idempotency for all settlement/scoring paths.
- Authorization enforced at the database level (RLS) and API level.
- Secrets via environment configuration only; never in client bundles.

## Out of Scope (MVP)

- Multiple programming languages (Python only).
- Real-money wagering, deposits, payouts, transferable tokens.
- Advanced tournament formats, social features, achievement NFTs.
- LLM-generated challenges during a live competition.
- Mobile app.

## Remaining Open Items

1. **G1 — Solana scope** (blocks M5; decide by end of M4).
2. Final three model IDs on OpenRouter (pick when cost/quality is assessed during M4).
3. Deployment host: Fly.io vs Railway vs Render (decide before M7; all support the Docker sandbox requirement).
4. Points formula (base points per correct pick, bonus for multi-category sweeps) — settle during F18.
5. Competition cadence for the demo (scheduled rounds vs admin-triggered) — likely admin-triggered for demo reliability.
