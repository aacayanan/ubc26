# AI Showdown — Web App

Next.js application for AI Showdown. The [root README](../README.md)
covers setup, environment configuration, database migrations, Docker,
and architecture — this file only notes what is specific to this
workspace.

## Development

Run from the repository root (npm workspaces):

```bash
npm ci
npm run dev
```

Open http://localhost:3000.

Build, lint, format, and typecheck commands also run from the
repository root — see
[Development Commands](../README.md#development-commands).

## Structure

- `app/` - Next.js App Router pages and routes
- `lib/config/` - Typed environment accessors (client and server)
- `lib/server/services/` - Backend business logic
- `lib/server/integrations/` - External integrations (Supabase,
  OpenRouter, Solana)
