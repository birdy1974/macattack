# syntax=docker/dockerfile:1
# ============================================================================
# MacAttack - Dockerfile (multi-architecture)
# ============================================================================
# This image is compiled by GitHub Actions on GitHub's runners (see
# .github/workflows/docker-image.yml) and pushed to GitHub Container
# Registry:  ghcr.io/birdy1974/macattack
#
# Target platforms:
#   linux/amd64  ->  Synology DS918+ (Intel Celeron J3455)
#   linux/arm64  ->  Raspberry Pi 4 (aarch64, 64-bit Raspberry Pi OS)
#
# The host (NAS or Pi) never compiles anything - docker-compose.yml just
# pulls the finished image from GHCR.
#
# Building locally is still possible (e.g. for development):
#   docker build -t macattack:dev .
#
# ---------------------------------------------------------------------------
# Why the build stage runs on $BUILDPLATFORM
# ---------------------------------------------------------------------------
# The application itself is 100% JavaScript, so the compiled Next.js output
# is byte-for-byte identical on every architecture. We therefore compile it
# ONCE, natively, on the runner's own CPU and reuse that output for all
# target platforms. Only the final runtime stage is architecture-specific.
#
# This has two big advantages over building every platform under QEMU:
#   * no slow emulated "npm install" / "next build" for arm64
#   * no chance of emulated-toolchain flakiness
#
# It is only safe because the app bundles no architecture-specific native
# module - see "sharp" note in the build stage below.
#
# ---------------------------------------------------------------------------
# Notes on Next.js "standalone" output:
#   .next/standalone/  -> server.js + minimal node_modules (self-contained)
#   .next/static/      -> JS/CSS chunks (NOT inside standalone!)
#   public/            -> static assets   (NOT inside standalone!)
# The standalone server.js expects:
#   <server_dir>/.next/static/   and   <server_dir>/public/
# so both are copied into the standalone directory during the build stage.
# ============================================================================

# ── Stage 1: install dependencies ──────────────────────────────────────────
# Runs on the native/build platform (see note above).
FROM --platform=$BUILDPLATFORM node:20-alpine AS deps
WORKDIR /app

# Toolchain for native modules
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

# ── Stage 2: compile the Next.js application ───────────────────────────────
# Runs on the native/build platform (see note above).
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Placeholder so the Next.js build succeeds without a live database.
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder

# ---------------------------------------------------------------------------
# The last two steps are what make this image multi-architecture:
#
#   1. npm run build      - produces .next/standalone
#   2. rm -rf .../sharp   - CRITICAL for arm64
#
# `sharp` is an *optional* dependency of Next.js used exclusively by the
# image optimizer. npm pulls in the prebuilt binary for the machine doing
# the build, e.g. @img/sharp-linux-x64 + @img/sharp-libvips-linux-x64
# (33 MB of x86_64 .node files). Those binaries are traced into
# .next/standalone, so shipping them would make the image crash on a
# Raspberry Pi with:
#     Error: Cannot find module '@img/sharp-linux-arm64'
 *
# MacAttack never uses next/image, so sharp is never loaded at runtime.
# Deleting it here keeps the runtime image architecture-independent
# (52 MB -> 20 MB of app files) and lets stages 1+2 run only once for
# every target platform. next.config.ts sets images.unoptimized, so no
# code path can try to reach the optimizer either.
# ---------------------------------------------------------------------------
RUN mkdir -p public \
 && npm run build \
 && cp -r .next/static .next/standalone/.next/static \
 && cp -r public .next/standalone/public \
 && cp init-schema.js wait-for-db.js docker-entrypoint.sh .next/standalone/ \
 && rm -rf .next/standalone/node_modules/sharp \
            .next/standalone/node_modules/@img

# ── Stage 3: minimal runtime image ─────────────────────────────────────────
# No --platform flag here on purpose: this stage is resolved for each
# TARGET platform, so it pulls the matching node:20-alpine (amd64 / arm64).
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
