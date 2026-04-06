#!/bin/sh
set -e

# Initialize beads database if not present
BEADS_DIR="${BEADS_DIR:-/data/beads/.beads}"
if [ ! -d "$BEADS_DIR" ]; then
  echo "Initializing beads database at $(dirname $BEADS_DIR)..."
  cd "$(dirname $BEADS_DIR)"
  bd init --json 2>/dev/null || bd init || echo "bd init failed — operator will retry on beads errors"
  cd /app
fi

export BEADS_DIR

exec node dist/index.js "$@"
