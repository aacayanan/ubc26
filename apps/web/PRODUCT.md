# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Hackathon judges and demo viewers first, then a general consumer audience who
follow AI models the way people follow competitors — they do not write code and
do not hold blockchain knowledge. Their situation is a live, time-boxed event
on a laptop or phone: something is about to happen, a clock is running, and
they either watch or take a side.

Two account shapes decide what a person can do, not who they are:

- **Wallet-identified account** (Sign in with Solana): can make predictions
  with Devnet SOL; finishes sign-up with a username and password.
- **Email/practice account**: browses, watches and votes on renders, but cannot
  make a prediction until a wallet is linked. Nobody ever needs a wallet to
  browse, watch or vote.

## Product Purpose

A live arena where language models are given one creative brief — a spinning
donut, a pulsing reactor core — and write code that renders. The audience
watches the code stream in chunks and the artifact take shape, wagering
valueless Devnet SOL on which model will conform (a $5 ante before the round
runs, live wagers while it generates), and voting on which result is best after
it does.

Success is a person who did not arrive caring about LLMs staying through a
round because the contest is legible on sight: two clocks, three renders, one
crowd verdict.

## Positioning

Conformance is measured; "best" is the crowd's. The two are never conflated,
and no vote, final render or verdict is visible before betting closes. Every
prediction's commitment hash lands on Solana Devnet in the same transaction as
its wager, so the record of when it was made cannot be backdated. The server
and database enforce the deadline; the chain timestamps it. The chain proves
the hash existed in time; which model it names is disclosed by the backer, not
readable by strangers. Most AI leaderboards publish a number nobody can audit;
this one publishes a commitment nobody can backdate.

## Operating Context

- Rounds are created by admin/server only. Users join rounds; they never create
  them.
- **The two clocks.** Betting window (`OPEN` until `prediction_deadline`), then
  `LOCKED` → `RUNNING` → `EVALUATING` → `SETTLED` → `ARCHIVED`. The crowd vote
  opens only after `LOCKED`.
- Three model renders run side by side per round. Code streams chunk by chunk
  as it is written.
- Every model receives the identical brief, chunking policy and token cap.
- The end-to-end flow must demo reliably in 2–3 minutes.

## Capabilities and Constraints

**Hard constraints (non-negotiable):**

- No real-money wagering, deposits or payouts. The parimutuel pool moves
  valueless Devnet test SOL only; Mainnet stays blocked pending legal and
  security review.
- LLM-generated code never executes on the application server — only inside a
  sandbox with CPU/memory/time limits and no network or filesystem access.
- A viewer-facing render runs in an iframe with `sandbox="allow-scripts"` and
  never `allow-same-origin`; `srcdoc` with a CSP of `connect-src 'none'`; no
  access to the app origin, cookies or storage.
- API credentials stay server-side.
- Solana Devnet for all blockchain interaction during development.

**What Solana does and does not guarantee.** On-chain (SPL Memo transactions,
no custom program): each wager's commitment hash, signed by the user's wallet
in the same transaction as the SOL transfer; operator-signed records of the
round (id, ante deadline, rules), the betting close and the settlement; and
payout transfers. These are records, **not enforcement** — the backend and
database enforce the deadline, and the chain only timestamps it. Not on-chain:
whether model execution or scoring was honest, whether the judge was impartial,
whether betting closed by the stated rule, or whether the treasury holds the
pool safely — those remain trusted-backend claims. Devnet is disposable, so
these are demo-grade guarantees. The source of truth is
`docs/solana-integration.md`; the site's plain-language copy lives only in
`lib/chain-guarantees.ts` (shown on `/on-chain`), never restated per page.

**Stack (existing):** Next.js 16 App Router, TypeScript, Tailwind CSS v4
(CSS-first `@theme`, no config file), Supabase (Postgres + auth + RLS),
OpenRouter for model access, Docker sandbox, three.js/Canvas as the generated
renderer.

**Terminology** (product truth — do not soften): brief, round, model, stake,
pool, conformance, crowd vote, forfeit, sealed commitment. "Challenge" is the
retired term for the pre-pivot coding-test format.

## Brand Commitments

- Product name: **Zelto**.
- Consumer UX first: a person must never need blockchain knowledge to use the
  product.
- Points and leaderboards only — no tokens, no NFTs, no real money.
- The visual world is pinned by the team (2026-11-19): organic cyberpunk glitch
  merged with cinematic AI-infrastructure minimalism. Monochrome SaaS structure;
  restrained magenta and violet status accents; halftone edges, grain and
  atmospheric distortion; a living flow-field vortex as the central organic
  visual. Dark only.

## Evidence on Hand

- `REQUIREMENTS.md` — decisions log, the two clocks, non-negotiable constraints,
  functional build order M0–M7, open items.
- `CLAUDE.md` — the pivot notice, architecture boundaries, scoring split.
- `supabase/migrations/` — the real schema: users, wallets, llm_models, briefs,
  competition_rounds, predictions, model_executions, rendered_artifacts,
  competition_results, user_scores, blockchain_transactions, plus RLS policies
  and the profile-sync trigger, with assertion tests in `supabase/tests/`.
- `apps/web/lib/server/services/` — round state machine, OpenRouter client,
  profile service, auth session.

**Absences future work must not fabricate:** there are no real users, no
settled rounds, no model win rates, no testimonials, and no benchmark numbers.
Every dataset shown in the UI today is either genuinely empty or explicitly
synthetic demonstration data, labelled as such.

## Product Principles

1. **Two clocks, never one.** Betting closes before any render exists; the vote
   opens only after. Any surface that blurs this order is wrong.
2. **Measured vs. chosen.** Conformance is a ruling; best is a verdict. Show
   them as separate columns, separate words, separate colors.
3. **Watchable, not homework.** The spectacle is the artifact taking shape.
   Never present this as an exam scoreboard.
4. **No blockchain knowledge required.** Wallets and commitments are plumbing
   that surfaces the verifiable property, not a toll gate.
5. **Prefer the reliable demo.** Every state must render sensibly empty, and no
   surface may require a live external service to look finished.

## Accessibility & Inclusion

- Pointer and keyboard parity for every control; visible focus rings themed from
  the palette, never removed.
- Body and placeholder text ≥4.5:1, large text ≥3:1, including on glass and
  halftone-tinted regions.
- All motion — including the WebGL vortex — respects `prefers-reduced-motion`
  and resolves to a composed still frame rather than a blank or broken canvas.
