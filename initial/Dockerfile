# ============================================================================
# MacAttack - Dockerfile for Synology NAS DS918+
# ============================================================================
#
# IMPORTANT: Next.js "standalone" output produces:
#   .next/standalone/         → server.js + node_modules (self-contained)
#   .next/static/             → JS/CSS chunks (NOT inside standalone!)
#   public/                   → static public assets (NOT inside standalone!)
#
# The standalone server.js expects:
#   .next/static/  → to be at <server_dir>/.next/static/
#   public/        → to be at <server_dir>/public/
#
# So after build we MUST copy both into the standalone directory.
# ============================================================================

FROM node:20-alpine

WORKDIR /app

# System deps for native modules
RUN apk add --no-cache python3 make g++

# Install npm packages
COPY package.json ./
RUN npm install --legacy-peer-deps

# Copy all source code
COPY . .

# Ensure public/ exists
RUN mkdir -p public

# Build-time environment
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Build Next.js (produces .next/standalone + .next/static)
RUN npm run build

# ── KEY STEP ──────────────────────────────────────────────────
# Copy the static chunks and public assets INTO the standalone
# directory so that server.js can serve them.
# Without this step every /_next/static/... request returns 404.
# ──────────────────────────────────────────────────────────────
RUN cp -r .next/static .next/standalone/.next/static
RUN cp -r public .next/standalone/public

# Copy helper scripts into standalone dir
RUN cp init-schema.js .next/standalone/init-schema.js
RUN cp wait-for-db.js .next/standalone/wait-for-db.js

# Clean up: remove source + full node_modules to shrink image
RUN rm -rf src node_modules .next/cache

# Non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Start: init DB schema, then run the standalone server
CMD ["sh", "-c", "node /app/.next/standalone/init-schema.js; node /app/.next/standalone/server.js"]
