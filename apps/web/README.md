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
- `app/globals.css` - Design tokens (Tailwind v4 `@theme`) and component
  classes
- `components/` - Design-system primitives (`ui.tsx`), icons, logo, site
  header, and the WebGL hero field
- `public/texture/` - Generated atmosphere assets (grain tile)
- `lib/config/` - Typed environment accessors (client and server)
- `lib/server/services/` - Backend business logic
- `lib/server/integrations/` - External integrations (Supabase,
  OpenRouter, Solana)

## Design system

This workspace has one visual world, documented in
[DESIGN.md](DESIGN.md) with machine-readable tokens in
[.impeccable/design.json](.impeccable/design.json). Product truth lives
in [PRODUCT.md](PRODUCT.md); the interface must not contradict it.

Tokens are declared in `app/globals.css` and consumed as Tailwind
classes — do not introduce raw palette classes. `components/ui.tsx`
holds the shared primitives, and `components/icons.tsx` the authored
icon set.
