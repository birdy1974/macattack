# syntax=docker/dockerfile:1
# ============================================================================
# MacAttack - Dockerfile
# ============================================================================
# This image is compiled by GitHub Actions on GitHub's runners (see
# .github/workflows/docker-image.yml) and pushed to GitHub Container
# Registry:  ghcr.io/birdy1974/macattack
#
# The Synology NAS never compiles anything - docker-compose.yml just pulls
# the finished image from GHCR.
#
# Building locally is still possible (e.g. for development):
#   docker build -t macattack:dev .
#
# Notes on Next.js "standalone" output:
#   .next/standalone/  -> server.js + minimal node_modules (self-contained)
#   .next/static/      -> JS/CSS chunks (NOT inside standalone!)
#   public/            -> static assets   (NOT inside standalone!)
# The standalone server.js expects:
#   <server_dir>/.next/static/   and   <server_dir>/public/
# so both are copied into the standalone directory during the build stage.
# ============================================================================

# ── Stage 1: install dependencies ──────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Toolchain for native modules
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

# ── Stage 2: compile the Next.js application ───────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Placeholder so the Next.js build succeeds without a live database.
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder

RUN mkdir -p public \
 && npm run build \
 && cp -r .next/static .next/standalone/.next/static \
 && cp -r public .next/standalone/public \
 && cp init-schema.js wait-for-db.js docker-entrypoint.sh .next/standalone/

# ── Stage 3: minimal runtime image ─────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Non-root user
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Everything from the standalone directory lands in /app:
#   /app/server.js, /app/init-schema.js, /app/wait-for-db.js,
#   /app/docker-entrypoint.sh, /app/node_modules, /app/.next/static,
#   /app/public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./

USER nextjs
EXPOSE 3000

# Entrypoint: wait for DB, apply schema, then start the standalone server
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
CMD ["node", "/app/server.js"]
