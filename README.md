//updated as of github issue #f1

# AI Showdown

AI Showdown is a hackathon application where users predict which
AI model will perform best in standardized coding competitions.

## Tech Stack

- Next.js, React, and TypeScript
- Tailwind CSS
- Supabase for authentication and PostgreSQL
- OpenRouter for AI model access
- Solana Devnet for blockchain verification

## Project Structure

- `apps/web` - Next.js application and API routes
- `packages/shared` - Shared TypeScript definitions
- `apps/web/lib/config` - Environment configuration
- `apps/web/lib/server/services` - Backend business logic
- `apps/web/lib/server/integrations` - External API integrations

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

Configure these variables when the corresponding integrations
are implemented:

- `NEXT_PUBLIC_SUPABASE_URL` - Public Supabase project URL
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` - Public Supabase key
- `OPENROUTER_API_KEY` - Private server-only API key
- `SUPABASE_SERVICE_ROLE_KEY` - Private server-only Supabase key that
  bypasses RLS (Supabase dashboard → Settings → API)

Never commit real API keys or secrets.

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
npm exec --workspace=web -- tsc --noEmit
```
Check TypeScript without producing compiled files.

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

The schema lives in `supabase/migrations/` — nine ordered SQL files covering
users, wallets, model/challenge catalogs, rounds, predictions, evaluation,
settlement, blockchain transactions, and the RLS policies. They apply cleanly
in order to a fresh Supabase project via `npm run db:push`.

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
(created from `apps/web/.env.example`). If it is missing, the app
still starts, but integrations that need keys (e.g. OpenRouter)
will not work.

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

- The evaluation sandbox (REQUIREMENTS.md F13) will run as a
  separate container later; this image only packages the web app.
- Never pass server-only keys (e.g. `OPENROUTER_API_KEY`) as
  `NEXT_PUBLIC_` variables.

## Architecture

Server-side business logic is organized into services for
authentication, competitions, evaluation, scoring, and blockchain.

External integrations are separated into Supabase, OpenRouter,
and Solana modules.

The shared package contains reusable TypeScript definitions.

## Security

Private API keys must remain on the server.

Server configuration uses `server-only` to prevent importing
private configuration modules into Client Components.

Only intended public variables use the `NEXT_PUBLIC_` prefix.

The Supabase service-role key (`SUPABASE_SERVICE_ROLE_KEY`) bypasses
row-level security. It must only be read from `lib/server/**` modules
(guarded by `server-only`), never serialized into API responses, and never
given a `NEXT_PUBLIC_` prefix. RLS policies in
`supabase/migrations/20261118100800_rls_policies.sql` protect user-owned
data at the database level; privileged server workflows (round transitions,
evaluation, settlement) use the service role.
