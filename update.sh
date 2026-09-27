#!/bin/sh
# ============================================================================
# MacAttack - Update Script (Synology NAS / Raspberry Pi 4)
# ============================================================================
# Pulls the newest pre-built image from GitHub Container Registry and
# restarts the app. Nothing is compiled on the host.
#
# The published image is multi-arch (linux/amd64 + linux/arm64), so Docker
# always pulls the variant matching the machine.
#
# Usage:  chmod +x update.sh && ./update.sh
# ============================================================================

set -e

# Prefer modern "docker compose", fall back to legacy "docker-compose"
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  COMPOSE="docker-compose"
fi

echo "======================================================="
echo "  MacAttack - pulling latest image from GitHub (ghcr.io)"
echo "======================================================="

$COMPOSE pull app

echo ""
echo "Restarting MacAttack with the new image..."
$COMPOSE up -d

echo ""
echo "Done! MacAttack is running at http://<HOST-IP>:3099"
echo "(Use a hard refresh in the browser: Ctrl+Shift+R / Cmd+Shift+R)"
