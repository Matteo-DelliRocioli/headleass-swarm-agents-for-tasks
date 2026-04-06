#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YAML="${SCRIPT_DIR}/../fixtures/instagram-clone/swarmrun.yaml"
RUN_NAME="instagram-clone-golden"
TIMEOUT=${TIMEOUT:-1800}  # 30 minutes default
POLL=${POLL:-30}           # 30 seconds

echo "=== Applying SwarmRun: ${RUN_NAME} ==="
kubectl apply -f "${YAML}"

echo "=== Polling for completion (timeout: ${TIMEOUT}s) ==="
START=$(date +%s)

while true; do
  ELAPSED=$(( $(date +%s) - START ))
  if (( ELAPSED > TIMEOUT )); then
    echo "ERROR: Timed out after ${TIMEOUT}s"
    kubectl get swarmrun "${RUN_NAME}" -o yaml
    kubectl delete swarmrun "${RUN_NAME}" --ignore-not-found
    exit 1
  fi

  PHASE=$(kubectl get swarmrun "${RUN_NAME}" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
  LOOP=$(kubectl get swarmrun "${RUN_NAME}" -o jsonpath='{.status.currentLoop}' 2>/dev/null || echo "?")
  CONF=$(kubectl get swarmrun "${RUN_NAME}" -o jsonpath='{.status.confidence}' 2>/dev/null || echo "?")

  echo "[${ELAPSED}s] Phase: ${PHASE} | Loop: ${LOOP} | Confidence: ${CONF}"

  case "${PHASE}" in
    Completed)
      echo "=== SUCCESS ==="
      kubectl get swarmrun "${RUN_NAME}" -o jsonpath='{.status.results}' | jq .
      kubectl delete swarmrun "${RUN_NAME}" --ignore-not-found
      exit 0
      ;;
    Failed|TimedOut)
      echo "=== FAILED (${PHASE}) ==="
      kubectl get swarmrun "${RUN_NAME}" -o jsonpath='{.status.message}'
      echo
      kubectl delete swarmrun "${RUN_NAME}" --ignore-not-found
      exit 1
      ;;
  esac

  sleep "${POLL}"
done
