#!/bin/bash
set -e

echo "[entrypoint] Waiting for OpenCode at localhost:4096..."
until curl -sf http://localhost:4096/health > /dev/null 2>&1; do
  sleep 1
done
echo "[entrypoint] OpenCode is ready"

echo "[entrypoint] Waiting for Beads at localhost:3307..."
until curl -sf http://localhost:3307/ > /dev/null 2>&1; do
  sleep 1
done
echo "[entrypoint] Beads is ready"

echo "[entrypoint] All dependencies ready, starting orchestrator"
exec node /app/dist/orchestrator.js
