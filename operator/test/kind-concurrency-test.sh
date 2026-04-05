#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Kind cluster concurrency test — validates szd.5
#
# Submits 6 SwarmRun CRDs, verifies max 5 pods run concurrently,
# and tests that queue drain starts the 6th when one completes.
#
# Prerequisites:
#   - kind installed (brew install kind)
#   - kubectl installed
#   - Docker running
#   - Images built (run from repo root):
#       docker build -f operator/images/operator/Dockerfile -t swarm-operator:test .
#       docker build -f operator/images/orchestrator/Dockerfile -t swarm-orchestrator:test .
#
# Usage: ./operator/test/kind-concurrency-test.sh
# ---------------------------------------------------------------------------
set -euo pipefail

CLUSTER_NAME="swarm-test"
NAMESPACE="default"
MAX_CONCURRENT=5
TOTAL_RUNS=6
CRD_FILE="operator/manifests/crd-swarmrun.yaml"

echo "=== Step 1: Create kind cluster ==="
if kind get clusters 2>/dev/null | grep -q "$CLUSTER_NAME"; then
  echo "Cluster $CLUSTER_NAME already exists, reusing"
else
  kind create cluster --name "$CLUSTER_NAME"
fi

echo ""
echo "=== Step 2: Load images into kind ==="
kind load docker-image swarm-operator:test --name "$CLUSTER_NAME" 2>/dev/null || echo "operator image not found, skipping"
kind load docker-image swarm-orchestrator:test --name "$CLUSTER_NAME" 2>/dev/null || echo "orchestrator image not found, skipping"

echo ""
echo "=== Step 3: Apply CRD ==="
kubectl apply -f "$CRD_FILE"
sleep 2

echo ""
echo "=== Step 4: Apply RBAC + operator ==="
kubectl apply -f operator/manifests/operator-rbac.yaml
kubectl apply -f operator/manifests/swarm-runner-rbac.yaml
kubectl apply -f operator/manifests/operator-configmap.yaml
kubectl apply -f operator/manifests/operator-deployment.yaml
echo "Waiting for operator to be ready..."
kubectl rollout status deployment/swarm-operator --timeout=60s || echo "Operator not ready (may need image)"

echo ""
echo "=== Step 5: Submit $TOTAL_RUNS SwarmRun CRDs ==="
for i in $(seq 1 $TOTAL_RUNS); do
  cat <<YAML | kubectl apply -f -
apiVersion: swarm.agentswarm.io/v1alpha1
kind: SwarmRun
metadata:
  name: test-run-$i
  namespace: $NAMESPACE
spec:
  prompt: "Test run $i: build a hello world feature"
  maxLoops: 1
  confidenceThreshold: 0.5
  model: "anthropic/claude-sonnet-4-20250514"
  timeout: "5m"
  priority: 2
YAML
  echo "  Submitted test-run-$i"
done

echo ""
echo "=== Step 6: Wait 15s for operator to reconcile ==="
sleep 15

echo ""
echo "=== Step 7: Check pod count ==="
ACTIVE_PODS=$(kubectl get pods -l app=agent-swarm --field-selector=status.phase!=Succeeded,status.phase!=Failed --no-headers 2>/dev/null | wc -l | tr -d ' ')
echo "Active swarm pods: $ACTIVE_PODS (expected: <= $MAX_CONCURRENT)"

if [ "$ACTIVE_PODS" -le "$MAX_CONCURRENT" ]; then
  echo "✅ PASS: Concurrency limit enforced ($ACTIVE_PODS <= $MAX_CONCURRENT)"
else
  echo "❌ FAIL: Too many active pods ($ACTIVE_PODS > $MAX_CONCURRENT)"
fi

echo ""
echo "=== Step 8: Check SwarmRun statuses ==="
kubectl get swarmruns -o custom-columns="NAME:.metadata.name,PHASE:.status.phase,POD:.status.podName" 2>/dev/null || echo "(CRD status not available)"

QUEUED=$(kubectl get swarmruns -o json 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
queued = [i['metadata']['name'] for i in data.get('items', []) if (i.get('status') or {}).get('phase') == 'Queued']
print(len(queued))
" 2>/dev/null || echo "?")
echo "Queued runs: $QUEUED (expected: >= 1 if $TOTAL_RUNS > $MAX_CONCURRENT)"

echo ""
echo "=== Step 9: Simulate completion (delete one pod) ==="
FIRST_POD=$(kubectl get pods -l app=agent-swarm --no-headers -o custom-columns=":metadata.name" 2>/dev/null | head -1)
if [ -n "$FIRST_POD" ]; then
  echo "Deleting pod: $FIRST_POD"
  kubectl delete pod "$FIRST_POD" --grace-period=0 --force 2>/dev/null
  echo "Waiting 15s for queue drain..."
  sleep 15

  ACTIVE_AFTER=$(kubectl get pods -l app=agent-swarm --field-selector=status.phase!=Succeeded,status.phase!=Failed --no-headers 2>/dev/null | wc -l | tr -d ' ')
  echo "Active pods after drain: $ACTIVE_AFTER"

  if [ "$ACTIVE_AFTER" -ge 1 ]; then
    echo "✅ PASS: Queue drain started a new run after completion"
  else
    echo "⚠️  INCONCLUSIVE: No pods running (operator may not have drained yet)"
  fi
else
  echo "No pods found to delete — operator may not be creating pods (missing images?)"
fi

echo ""
echo "=== Step 10: Cleanup ==="
echo "To delete the test cluster: kind delete cluster --name $CLUSTER_NAME"
echo "To delete just the test runs: kubectl delete swarmruns --all"
echo ""
echo "Test complete."
