# AI Showdown

AI Showdown is a live visual showdown. AI models are given a creative brief
(a spinning donut, a pulsing reactor core) and write code that renders on
screen. The audience watches each model's code stream in and its artwork take
shape, then decides which is best.

Betting and judging are separate. Users stake points on a model **before** the
round runs — sealed on-chain, so the pick cannot be hindsight. Conformance
(does it run, does it follow the brief) is judged by deterministic checks plus
a vision model; "best" is decided by the crowd.

> **Note (2026-11-19):** this replaced an earlier plan of standardized Python
> coding challenges scored on correctness, speed and code length. See the
> pivot notice at the top of [`REQUIREMENTS.md`](REQUIREMENTS.md).

## Tech Stack

- Next.js, React, and TypeScript
- Tailwind CSS
- Supabase for authentication and PostgreSQL
- OpenRouter for AI model access
- Solana Devnet for blockchain verification

## Project Structure

- `apps/web` - Next.js application and API routes
- `apps/web/app/(public)` - Marketing surface: landing, login, competitions,
  leaderboard, models, results
- `apps/web/app/(app)` - Authenticated surface: dashboard, predictions,
  profile, first-run wallet link (route groups do not change URLs)
- `apps/web/proxy.ts` - Per-request protected-route gate and token refresh
  (Next 16 renamed `middleware.ts` to `proxy.ts`)
- `apps/web/components` - Shared shell: header, mobile nav, sign-out,
  practice badge, wallet-link flow
- `apps/web/lib/supabase` - Browser Supabase client (publishable key only)
- `apps/web/lib/wallets` - Wallet link helpers and practice-mode toggle
- `packages/shared` - Shared TypeScript definitions
- `apps/web/lib/config` - Environment configuration
- `apps/web/lib/server/services` - Backend business logic
- `apps/web/lib/server/integrations` - External API integrations
- `apps/web/lib/server/{errors,http,logging,background}` - F3 conventions:
  typed app errors, shared API error responses, structured redacted logs,
  and the background-task wrapper
- `supabase/` - Database migrations, CLI config, and schema assertion tests

## Getting Started

Requirements:

- Node.js
- npm

Clone the repository and run these commands from the project root:

```bash
npm ci
npm run dev
```

Open http://localhost:3000 in your browser.

## Environment Configuration

Copy `apps/web/.env.example` to `apps/web/.env.local`.

The app currently needs both Supabase values to run at all — the Supabase
clients throw on startup without them:

- `NEXT_PUBLIC_SUPABASE_URL` - Public Supabase project URL
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` - Public Supabase key

Configure these when the corresponding integrations are implemented:

- `OPENROUTER_API_KEY` - Private server-only API key
- `SUPABASE_SERVICE_ROLE_KEY` - Private server-only Supabase key that
  bypasses RLS (Supabase dashboard → Settings → API). Required from F13
  on: sandbox result writes have no RLS write policy, so only the
  service role can record evaluation results.

OpenRouter calls have optional tuning knobs, all defaulted:
`OPENROUTER_BASE_URL`, `OPENROUTER_TIMEOUT_MS` (60000),
`OPENROUTER_MAX_ATTEMPTS` (3) and `OPENROUTER_FORFEIT_THRESHOLD` (3). The
model lineup is not configured here — it is the active rows in the
`llm_models` table, ordered by `sort_order`.

Never commit real API keys or secrets.

## Authentication

Login-first. Users authenticate with email/password **or** Sign in with Solana
(Phantom) — the wallet is a first-class identity, not an optional extra.

Supabase configuration required before auth works:

- **Email provider:** Authentication → Sign In / Providers → Email. Turn
  **Confirm email** off, or sign-up returns no session and the app never sees
  a logged-in user. (This is a hosted-dashboard setting; `supabase/config.toml`
  only governs a local `supabase start`.)
- **Web3 provider:** Authentication → Sign In / Providers → Web3 → Solana
  enabled. Verify with `supabase/config.toml`'s `[auth.web3.solana]
enabled = true`, then set the same toggle in the hosted dashboard.
- **Provider credentials live in the Supabase dashboard only.** Nothing
  provider-related belongs in `.env.local`, and no provider secret ever reaches
  the app or its bundle.

How the code enforces it:

- `apps/web/proxy.ts` runs on every non-asset request. It refreshes the session
  cookie (so sessions survive a hard refresh), redirects unauthenticated hits
  on `/dashboard`, `/predictions`, `/profile`, `/link-wallet` to
  `/login?next=<path>`, and bounces signed-in users away from `/login`.
- `apps/web/app/(app)/layout.tsx` wraps its children in a Suspense boundary
  that awaits `requireUser()` from
  `apps/web/lib/server/services/auth/session.ts` — defence in depth, since
  layout checks do not re-run on client-side navigation. That module is also
  the seam where profile sync and points reads will plug in (F6).
- Adding a protected page means adding its prefix to `PROTECTED` in
  `proxy.ts`; the layout gate already covers everything under `app/(app)`.

### Wallet and practice accounts

Signing in with Solana creates a wallet-identified account. Email users see a
first-run `/link-wallet` screen and can either connect a wallet or continue in
practice mode. `public.users.funded` is **derived** — it is true exactly when
the account has a row in `public.wallets` — and is maintained by trigger, not
settable by clients. `practice_mode` is self-service (it can only reduce
access). Rounds are created by the admin/server side; users only join them, and
only a funded account joining starts a live prompt session.

## Development Commands

Run commands from the repository root.

```bash
npm run dev
```

Start the Next.js development server.

```bash
npm run build
```

Create an optimized production build.

```bash
npm run lint
```

Check code with ESLint.

```bash
npm run format
```

Automatically format code with Prettier.

```bash
npm run format:check
```

Check formatting without changing files.

```bash
npm test
```

Run unit tests with Vitest (no network needed). The live OpenRouter check is
skipped unless `OPENROUTER_API_KEY` and `OPENROUTER_TEST_MODEL_ID` are set:

```bash
OPENROUTER_API_KEY=... OPENROUTER_TEST_MODEL_ID=... npx vitest run \
  test/integration/openrouter.integration.test.ts --root apps/web
```

```bash
npm run typecheck
```

Regenerate route types (`next typegen`) and check TypeScript without producing
compiled files. Run this after moving or renaming any page — route group and
`LayoutProps` types are generated per path.

```bash
npm run db:link -- --project-ref <your-project-ref>
```

One-time: link the Supabase CLI to a hosted project.

```bash
npm run db:push
```

Apply pending migrations from `supabase/migrations/` (filename order) to the
linked project.

## Database

The schema lives in `supabase/migrations/` — thirteen ordered SQL files covering
users, wallets, model/challenge catalogs, rounds, predictions, evaluation,
settlement, blockchain transactions, the RLS policies, and the profile-sync
trigger that creates a `public.users` row for every new auth account. The last
three extend evaluation for the sandbox (F13: `challenges.entry_point`,
`model_executions.sandbox_image`/`harness_protocol`) and for OpenRouter (F16:
`provider_request_id`, `attempt_count`, `failure_kind`, `response_meta`). They
apply cleanly in order to a fresh Supabase project via `npm run db:push`.

Each new auth user gets its `public.users` row from the `on_auth_user_created`
trigger in `20261118100900_profile_sync_and_funding_status.sql`. Without that
row, the foreign keys from `wallets` and `predictions` fail — so apply the
migration before linking a wallet. The same file adds `practice_mode` and
derives `funded` from the presence of a wallet row.

Assertion scripts in `supabase/tests/` verify the schema acceptance criteria
(duplicate/invalid-data rejection and RLS behavior). Run each one in the
hosted Supabase SQL editor: every assertion raises `FAIL: …` on violation,
a final select confirms success, and everything is rolled back so no data
persists.

## Docker

The app ships as a production Docker image defined in the repo-root
`Dockerfile`. Requirements: Docker with Compose v2 (on macOS,
Colima or Docker Desktop both work).

### Quick start

From the repository root:

```bash
docker compose up --build
```

Open http://localhost:3000. To run detached:

```bash
docker compose up --build -d
docker compose logs -f web   # follow app logs
docker compose down          # stop and remove the container
```

### Environment variables

Compose loads `apps/web/.env.local` automatically if the file exists
(created from `apps/web/.env.example`). The two `NEXT_PUBLIC_SUPABASE_*`
values are required — the Supabase client helpers throw without them, so the
app will start and then fail on any page that touches auth. OpenRouter and
service-role keys only matter once those integrations land.

Secrets are provided at **runtime**, never baked into the image —
`.dockerignore` excludes every `.env` file from the build context.

### Plain Docker (without Compose)

```bash
docker build -t ai-showdown .
docker run --rm -p 3000:3000 --env-file apps/web/.env.local ai-showdown
```

### How the image works

- Multi-stage build: `npm ci` → `next build` → slim Alpine runtime.
- Next.js standalone output keeps the final image small (~300 MB).
- The container runs as a non-root `nextjs` user on port 3000.
- The lockfile records native binaries for all platforms, so the
  build works on macOS, Windows, and Linux machines alike.

### Notes

- The evaluation sandbox lives in `sandbox/` and runs as its own
  image. See [Sandbox](#sandbox) and
  [`docs/sandbox-threat-model.md`](docs/sandbox-threat-model.md).
- Never pass server-only keys (e.g. `OPENROUTER_API_KEY`) as
  `NEXT_PUBLIC_` variables.

## Sandbox

Every LLM-generated solution runs in a fresh container from `sandbox/`, never in
the app process. The container has no network, a read-only rootfs, CPU/memory/
process limits, and drops each test to an unprivileged uid. The load-bearing
control is that **expected answers never enter the container** — it returns the
solution's value and the host decides pass/fail, so a forged result can only
substitute the solution's own answer.

Build and pin the image:

```bash
npm run sandbox:build
docker image inspect ai-showdown-sandbox:py3.12 \
  --format '{{index .RepoDigests 0}}'
```

Put that digest-pinned reference in `apps/web/.env.local` as `SANDBOX_IMAGE`.
The runner refuses a tag-only reference, because a tag re-pulls and would change
what a past verdict meant.

The runner needs access to a Docker daemon — a mounted socket locally, or a
sidecar at deploy time (deployment host is still an open item, F28). Full
control stack, measured attack results, and residual risks:
[`docs/sandbox-threat-model.md`](docs/sandbox-threat-model.md).

## Architecture

Server-side business logic is organized into services for
authentication, competitions, evaluation, scoring, and blockchain.

External integrations are separated into Supabase, OpenRouter,
and Solana modules.

The OpenRouter client (F16) lives in
`lib/server/integrations/openrouter/`. Every model receives the same prompt
from `lib/server/services/llm/prompt.ts`; each call records the exact model id,
the generation params, the prompt-template version and a hash of the prompt
text, plus latency and per-attempt diagnostics in `model_executions`. Timeouts,
rate limits, unavailable models, malformed output and auth/credit failures are
typed outcomes, not exceptions. Transient failures are retried up to
`OPENROUTER_MAX_ATTEMPTS`; after `OPENROUTER_FORFEIT_THRESHOLD` failed attempts
the model forfeits the round. The row-level `attempt` is the orchestration
attempt (F17) and never advances because of an internal retry.

The shared package contains reusable TypeScript definitions.

Competition lifecycle transitions use a shared state machine in
`apps/web/lib/server/services/competitions/`. The database provides the
same transition rules through `public.transition_round(...)`, a
compare-and-set RPC that creates auditable lifecycle events and has
retry-safe same-status behavior.

Administrators use the same Supabase login as regular users and are routed
to `/admin`. The protected admin dashboard creates and opens competitions
through the server-only `public.create_competition(...)` RPC; regular users
see only OPEN competitions through `/api/competitions`.

API routes and background jobs use the server error convention in
`apps/web/lib/server/errors/app-error.ts`. API failures use the shared
response handler in `apps/web/lib/server/http/api-error.ts`; background
jobs use `runBackgroundTask` in `apps/web/lib/server/background/task.ts`.
Correlation IDs join related API and background logs. Structured logs
automatically redact credential-like fields and private evaluation
fields such as prompts and generated-code output.

Access control is layered rather than trusted once:

1. `apps/web/proxy.ts` — per-request session refresh and route gate.
2. `app/(app)/layout.tsx` — Suspense-wrapped `requireUser()`, the
   authoritative check that still runs when a layout is reused on
   client-side navigation.
3. Row-level security in Postgres — the final gate on every read and write.

Server code reaches Supabase through
`lib/server/integrations/supabase/server.ts` (cookie-bound, `server-only`).
Browser code reaches it through `lib/supabase/browser.ts`, which can only ever
see the publishable key. Client components fetch under RLS, so each query is
already scoped to the signed-in user.

`apps/web/app` uses two route groups: `(public)` renders marketing chrome and a
"points only — no real money" footer, `(app)` renders the authenticated shell
behind the auth gate. Route groups do not appear in URLs.

## Security

Private API keys must remain on the server.

Server configuration uses `server-only` to prevent importing
private configuration modules into Client Components.

Only intended public variables use the `NEXT_PUBLIC_` prefix.

OAuth and Web3 provider credentials are configured in the Supabase
dashboard, never in this repository — the app only ever holds the
Supabase URL and publishable key.

The Supabase service-role key (`SUPABASE_SERVICE_ROLE_KEY`) bypasses
row-level security. It must only be read from `lib/server/**` modules
(guarded by `server-only`), never serialized into API responses, and never
given a `NEXT_PUBLIC_` prefix. RLS policies in
`supabase/migrations/20261118100800_rls_policies.sql` protect user-owned
data at the database level; privileged server workflows (round transitions,
evaluation, settlement) use the service role.
