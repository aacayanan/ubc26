# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**AI Showdown** — a consumer-facing prediction platform where users predict which LLMs (GPT, Claude, Gemini) will win standardized Python coding challenges, judged on accuracy (test cases passed), execution speed, and code length. Built for the UBC 2026 Hackathon, Track 03 (Consumer Applications), on Solana Devnet. Submission deadline: **November 20, 2026, 12:00 PM CST**.

Repo state: greenfield as of 2026-11-16 — no code yet. Detailed requirements and build order live in `REQUIREMENTS.md` (decisions log, milestones M0–M7, open items); follow that ordering when implementing.

## Non-negotiable constraints

- **No real-money wagering, deposits, or payouts** without an explicit product decision. MVP uses points / nonredeemable test rewards only.
- **Never execute LLM-generated code on the application server.** All evaluation runs in an isolated sandbox with CPU/memory/time limits and no network/filesystem access.
- **API credentials stay server-side** — LLM provider keys, DB credentials, and any evaluator secrets must never reach the client bundle.
- **Solana Devnet** for all blockchain interaction during development.
- Consumer UX first: users must not need blockchain knowledge to use the product.
- The whole demo must run reliably end-to-end in 2–3 minutes (hackathon demo video requirement).

## What Solana does vs. what it doesn't

On-chain (Solana): prediction commitments (hashes), competition IDs and deadlines, deadline enforcement, verifiable prediction history, settlement/achievement records.

Off-chain (PostgreSQL): user data, generated code, test results, large datasets, private information.

Blockchain verification guarantees that commitments existed before the deadline and were not altered. It does **not** verify that model execution or scoring was honest — that still depends on the trusted backend. Document this distinction in any user-facing or judge-facing material.

## Competition lifecycle (state machine)

`CREATED → OPEN → LOCKED → RUNNING → EVALUATING → SETTLED → ARCHIVED`, plus failure/cancel/retry states.

Rules that must hold in code:

- Predictions accepted only in `OPEN`; late or duplicate submissions rejected at both API and (where possible) on-chain level.
- State transitions are one-directional and validated — no invalid jumps, no modifications to finalized (`SETTLED`/`ARCHIVED`) results.
- Scoring runs idempotently — interrupted settlement must not double-score.
- Defined behavior for: model API failure, execution failure, ties, all-models-failing, blockchain tx failure, interrupted settlement.

## Scoring rules

- A model must **pass all correctness tests** to qualify for speed or code-length categories.
- Speed: benchmark under consistent conditions (fixed environment, repeated runs, warm-up).
- Code length: normalize formatting first; use one consistent counting method (e.g., non-whitespace characters of the formatted source).

## Locked stack decisions

- **Auth + DB**: Supabase all-in-one (Postgres + auth + RLS). Login-first (email/social); Phantom wallet link is optional, needed only for on-chain commitment verification.
- **LLM access**: OpenRouter — one integration, model IDs in config. Lineup: the cheapest three capable models, chosen at config time.
- **Sandbox**: fresh Docker container per evaluation run (`--network-none`, CPU/memory/time limits), deployed on a container-capable host (Fly.io / Railway / Render) — not Vercel.
- **Challenges**: hybrid — hand-seeded bank for the MVP; a generation pipeline may expand the bank, but challenges are never generated live mid-competition.
- **Rewards**: points / leaderboard only. No tokens, no NFTs, no real money.

## Architecture boundaries

Keep frontend, business logic, and external integrations decoupled. Backend services: auth/user management, competition management, challenge management, prediction management, LLM orchestration, code evaluation/sandboxing, scoring/settlement, blockchain integration.

- **LLM integration**: identical prompts and eval instructions to every model; record exact model identifier + config; handle timeouts/failures/unavailable models explicitly; store generated solutions and execution metadata.
- **Database**: Supabase Postgres. Core entities: Users, Wallets, LLM Models, Challenges, Competition Rounds, Predictions, Model Executions, Test Results, Competition Results, User Scores, Blockchain Transactions.

## Development priorities

- **P0 (MVP, must ship)**: frontend, basic auth, competition lifecycle, prediction submit/lock, 3 LLMs integrated, Python challenge evaluation, correctness/speed/length scoring, results display, meaningful Solana Devnet integration.
- **P1**: leaderboard, historical LLM performance, prediction history, live progress display, better error handling/tests.
- **P2 (post-hackathon)**: more languages, tournament formats, more providers, social/achievements, sophisticated rewards, real-money (gated on legal/security review).

Prefer simple, reliable solutions over abstractions. The hackathon window is short — prioritize a working end-to-end product.

## Hackathon deliverables

Public GitHub repo, architecture documentation + README, deployed working demo, 2–3 minute demo video. The demo must show: meaningful blockchain interaction, a clear consumer use case, and intuitive UX.

## Open decisions (see REQUIREMENTS.md for full list)

1. Solana scope (gated — decide before M5): Anchor program with commitments + deadline enforcement vs. lightweight tx records vs. full on-chain. Not recommended: full on-chain predictions/settlement given the timeline.
2. Final three OpenRouter model IDs (assess during LLM orchestration work).
3. Deployment host: Fly.io vs Railway vs Render (must run Docker).
4. Points formula and demo competition cadence (admin-triggered rounds for demo reliability).
