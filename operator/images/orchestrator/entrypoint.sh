#!/bin/bash
set -e

OPENCODE_HOST="${OPENCODE_HOST:-localhost}"
OPENCODE_PORT="${OPENCODE_PORT:-4096}"

echo "[entrypoint] Waiting for OpenCode at ${OPENCODE_HOST}:${OPENCODE_PORT}..."
until curl -sf "http://${OPENCODE_HOST}:${OPENCODE_PORT}/health" > /dev/null 2>&1; do
  sleep 1
done
echo "[entrypoint] OpenCode is ready"

echo "[entrypoint] Starting orchestrator"
exec node /app/dist/index.js
