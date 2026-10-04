#!/bin/sh
set -e

echo "========================================================"
echo "           MacAttack - Starting Up                       "
echo "========================================================"

# Wait for the database to be ready
echo "Waiting for database..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ "$RETRY_COUNT" -lt "$MAX_RETRIES" ]; do
  if node /app/wait-for-db.js 2>/dev/null; then
    echo "Database is ready!"
    break
  fi
  RETRY_COUNT=$((RETRY_COUNT + 1))
  echo "  Attempt $RETRY_COUNT/$MAX_RETRIES - retrying in 2s..."
  sleep 2
done

if [ "$RETRY_COUNT" -eq "$MAX_RETRIES" ]; then
  echo "WARNING: Database not available after $MAX_RETRIES attempts, starting anyway..."
fi

# Apply database schema
echo "Applying database schema..."
node /app/init-schema.js || echo "WARNING: Schema push skipped"

# FFmpeg probe: picture checks/thumbnails need it, and a stale FFMPEG_PATH
# override or an old image is the usual cause of "ffmpeg: not found".
if [ -n "$FFMPEG_PATH" ]; then
  echo "FFMPEG_PATH is set to: $FFMPEG_PATH"
  if [ ! -x "$FFMPEG_PATH" ]; then
    echo "WARNING: FFMPEG_PATH does not point to an executable inside this container."
    echo "         The bundled image needs no override — unset FFMPEG_PATH unless the path is correct."
  fi
fi
if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg: $(ffmpeg -hide_banner -version 2>/dev/null | head -n 1 || echo 'present')"
else
  echo "WARNING: ffmpeg not found on PATH in this container."
  echo "         Pull the latest image: docker compose pull app && docker compose up -d"
fi
if [ -n "$MACATTACK_FFMPEG_DRI_DEVICE" ]; then
  if [ -r "$MACATTACK_FFMPEG_DRI_DEVICE" ] && [ -w "$MACATTACK_FFMPEG_DRI_DEVICE" ]; then
    echo "VAAPI device $MACATTACK_FFMPEG_DRI_DEVICE is accessible (hardware decode will be attempted)."
  else
    echo "WARNING: VAAPI device $MACATTACK_FFMPEG_DRI_DEVICE is not readable/writable — software decode will be used."
  fi
fi

echo "Starting MacAttack..."
exec "$@"
