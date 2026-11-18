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
