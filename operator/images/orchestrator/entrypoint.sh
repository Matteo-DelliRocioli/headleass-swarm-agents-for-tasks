#!/bin/bash
set -e

OPENCODE_HOST="${OPENCODE_HOST:-localhost}"
OPENCODE_PORT="${OPENCODE_PORT:-4096}"

# Set git identity for regression gate commits
git config --global user.email "swarm@agentswarm.io"
git config --global user.name "Swarm Orchestrator"

# Initialize beads in workspace if needed
cd /workspace
if [ ! -d .beads ]; then
  bd init --stealth 2>/dev/null || true
fi

# Initialize git in workspace if needed
if [ ! -d .git ]; then
  git init
  git add -A 2>/dev/null || true
  git commit -m "swarm: initial workspace" --allow-empty 2>/dev/null || true
fi

echo "[entrypoint] Waiting for OpenCode at ${OPENCODE_HOST}:${OPENCODE_PORT}..."
until curl -sf "http://${OPENCODE_HOST}:${OPENCODE_PORT}/api/health" > /dev/null 2>&1 || curl -sf "http://${OPENCODE_HOST}:${OPENCODE_PORT}/" > /dev/null 2>&1; do
  sleep 1
done
echo "[entrypoint] OpenCode is ready"

echo "[entrypoint] Starting orchestrator"
exec node /app/dist/index.js
