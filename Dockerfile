# syntax=docker/dockerfile:1

# Production image for the AI Showdown web app (monorepo: apps/web).
# Build from the repository root:  docker build -t ai-showdown .
# Run:                             docker run --rm -p 3000:3000 ai-showdown

# ---------------------------------------------------------------------------
# Base
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------------------
# Dependencies — install from the lockfile only when manifests change
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

# ---------------------------------------------------------------------------
# Build — compile the Next.js production bundle
# ---------------------------------------------------------------------------
FROM base AS builder
# Copy the full dependency tree — npm nests some workspace deps
# (e.g. apps/web/node_modules) instead of hoisting them all.
COPY --from=deps /app ./
COPY . .
# Secret values are provided at build time (e.g. --build-arg) and inlined
# only into server bundles, never the client. None are required for the
# current scaffold; add ARGs here as integrations land.
RUN npm run build

# ---------------------------------------------------------------------------
# Runner — minimal final image, runs as a non-root user
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "apps/web/server.js"]
