#!/bin/bash
# ============================================================================
# MacAttack - Build Script for Synology NAS
# ============================================================================
#
# Usage:
#   chmod +x build.sh
#   ./build.sh
#
# This script:
# 1. Sets extended Docker timeouts to prevent build failures
# 2. Starts the PostgreSQL database
# 3. Builds the MacAttack Docker image
# 4. Starts all services
# ============================================================================

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              MacAttack - Docker Build Script                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Extended timeouts (10 minutes)
export DOCKER_CLIENT_TIMEOUT=600
export COMPOSE_HTTP_TIMEOUT=600
export DOCKER_BUILDKIT=0

echo "📦 Step 1/4: Stopping existing containers..."
docker-compose down 2>/dev/null || true

echo ""
echo "📦 Step 2/4: Starting PostgreSQL database..."
docker-compose up -d db
echo "   Waiting 10 seconds for database to initialize..."
sleep 10

echo ""
echo "🔨 Step 3/4: Building MacAttack application..."
echo "   This may take 10-15 minutes on first build."
echo "   Please be patient!"
echo ""

# Build the image
docker build --network=host -t mac-attack-app .
BUILD_EXIT=$?

if [ $BUILD_EXIT -eq 0 ]; then
    echo ""
    echo "✅ Build successful!"
    echo ""
    echo "🚀 Step 4/4: Starting MacAttack..."
    docker-compose up -d
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║              MacAttack is now running!                       ║"
    echo "╠══════════════════════════════════════════════════════════════╣"
    echo "║                                                              ║"
    echo "║  Open in your browser:                                       ║"
    echo "║  http://<YOUR-NAS-IP>:3099                                   ║"
    echo "║                                                              ║"
    echo "║  If the page doesn't load, do a hard refresh:                ║"
    echo "║  Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)                ║"
    echo "║                                                              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
else
    echo ""
    echo "❌ Build failed! (exit code: $BUILD_EXIT)"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Check disk space:     df -h"
    echo "  2. Check Docker logs:    docker-compose logs"
    echo "  3. Try background build: nohup docker build --network=host -t mac-attack-app . > build.log 2>&1 &"
    echo "     Then watch:           tail -f build.log"
    echo ""
fi
