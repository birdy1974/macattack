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

echo "Starting MacAttack..."
exec "$@"
