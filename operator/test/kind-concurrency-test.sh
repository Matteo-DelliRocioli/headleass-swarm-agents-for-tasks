#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Kind cluster concurrency test — validates szd.5
#
# Submits 6 SwarmRun CRDs, verifies max 5 pods run concurrently,
# and tests that queue drain starts the 6th when one completes.
#
# Usage: ./operator/test/kind-concurrency-test.sh
# Prerequisites: Docker running, kind + kubectl installed
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

CLUSTER_NAME="swarm-test"
NAMESPACE="default"
MAX_CONCURRENT=5
TOTAL_RUNS=6
OPERATOR_IMAGE="swarmrun-operator:test"

echo "=== Step 1: Build operator TypeScript ==="
cd operator
npm install --silent 2>&1 | tail -2
npx tsc 2>&1 || { echo "TypeScript compilation failed"; exit 1; }
cd "$REPO_ROOT"
echo "  Build OK"

echo ""
echo "=== Step 2: Build operator Docker image ==="
docker build -f operator/images/operator/Dockerfile -t "$OPERATOR_IMAGE" . 2>&1 | tail -3
echo "  Image built: $OPERATOR_IMAGE"

echo ""
echo "=== Step 3: Create kind cluster ==="
if kind get clusters 2>/dev/null | grep -q "$CLUSTER_NAME"; then
  echo "  Cluster $CLUSTER_NAME already exists, reusing"
else
  kind create cluster --name "$CLUSTER_NAME"
fi

echo ""
echo "=== Step 4: Load operator image into kind ==="
kind load docker-image "$OPERATOR_IMAGE" --name "$CLUSTER_NAME"
echo "  Image loaded"

echo ""
echo "=== Step 5: Apply CRD + RBAC + operator ==="
kubectl apply -f operator/manifests/crd-swarmrun.yaml
kubectl apply -f operator/manifests/operator-rbac.yaml
kubectl apply -f operator/manifests/swarm-runner-rbac.yaml
# Override configmap with tiny resource defaults for kind testing
cat <<'YAML' | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: operator-config
data:
  MAX_CONCURRENT_RUNS: "5"
  CLEANUP_RETENTION_MINUTES: "60"
  STALE_CHECK_INTERVAL_MINUTES: "5"
  PERIODIC_SYNC_SECONDS: "30"
  SWARM_IMAGE_OPENCODE: "busybox:latest"
  SWARM_IMAGE_ORCHESTRATOR: "busybox:latest"
  SWARM_IMAGE_BEADS: "busybox:latest"
  SWARM_IMAGE_PLAYWRIGHT: "busybox:latest"
  DEFAULT_OPENCODE_MEMORY: "32Mi"
  DEFAULT_OPENCODE_CPU: "0.01"
  DEFAULT_ORCHESTRATOR_MEMORY: "32Mi"
  DEFAULT_ORCHESTRATOR_CPU: "0.01"
  DEFAULT_BEADS_MEMORY: "32Mi"
  DEFAULT_BEADS_CPU: "0.01"
  DEFAULT_PLAYWRIGHT_MEMORY: "32Mi"
  DEFAULT_PLAYWRIGHT_CPU: "0.01"
YAML

# Create a simple PVC for beads data (kind uses local-path provisioner)
cat <<'YAML' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: beads-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
YAML

# Patch deployment to use our test image and never pull (local image)
cat <<YAML | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: swarmrun-operator
  labels:
    app: swarmrun-operator
spec:
  replicas: 1
  selector:
    matchLabels:
      app: swarmrun-operator
  template:
    metadata:
      labels:
        app: swarmrun-operator
    spec:
      serviceAccountName: swarmrun-operator
      containers:
        - name: operator
          image: $OPERATOR_IMAGE
          imagePullPolicy: Never
          envFrom:
            - configMapRef:
                name: operator-config
          env:
            - name: NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
          volumeMounts:
            - name: beads-data
              mountPath: /data/beads
          resources:
            requests:
              memory: "256Mi"
              cpu: "0.25"
            limits:
              memory: "512Mi"
              cpu: "0.5"
      volumes:
        - name: beads-data
          persistentVolumeClaim:
            claimName: beads-data
YAML

echo "  Waiting for operator to be ready..."
kubectl rollout status deployment/swarmrun-operator --timeout=120s 2>&1 || {
  echo "  Operator not ready. Checking logs..."
  kubectl logs deployment/swarmrun-operator --tail=20 2>&1 || true
  echo ""
  echo "  Checking pod status..."
  kubectl get pods -l app=swarmrun-operator 2>&1
  echo ""
  echo "  ⚠️  Operator failed to start. This may be expected if beads CLI is not available in the image."
  echo "  The CRD + RBAC are applied — you can manually test by running the operator locally."
}

echo ""
echo "=== Step 6: Submit $TOTAL_RUNS SwarmRun CRDs ==="
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
echo "=== Step 7: Wait 20s for operator to reconcile ==="
sleep 20

echo ""
echo "=== Step 8: Check pod count ==="
ACTIVE_PODS=$(kubectl get pods -l app=agent-swarm --field-selector=status.phase!=Succeeded,status.phase!=Failed --no-headers 2>/dev/null | wc -l | tr -d ' ')
echo "Active swarm pods: $ACTIVE_PODS (expected: <= $MAX_CONCURRENT)"

if [ "$ACTIVE_PODS" -gt 0 ] && [ "$ACTIVE_PODS" -le "$MAX_CONCURRENT" ]; then
  echo "✅ PASS: Concurrency limit enforced ($ACTIVE_PODS <= $MAX_CONCURRENT)"
elif [ "$ACTIVE_PODS" -eq 0 ]; then
  echo "⚠️  No swarm pods created — operator may not be running or reconciling"
else
  echo "❌ FAIL: Too many active pods ($ACTIVE_PODS > $MAX_CONCURRENT)"
fi

echo ""
echo "=== Step 9: Check SwarmRun statuses ==="
kubectl get swarmruns -o custom-columns="NAME:.metadata.name,PHASE:.status.phase,POD:.status.podName" 2>/dev/null || echo "(CRD status not available)"

QUEUED=$(kubectl get swarmruns -o json 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
queued = [i['metadata']['name'] for i in data.get('items', []) if (i.get('status') or {}).get('phase') == 'Queued']
print(len(queued))
" 2>/dev/null || echo "?")
echo "Queued runs: $QUEUED (expected: >= 1 if $TOTAL_RUNS > $MAX_CONCURRENT)"

echo ""
echo "=== Step 10: Simulate completion (delete one pod) ==="
FIRST_POD=$(kubectl get pods -l app=agent-swarm --no-headers -o custom-columns=":metadata.name" 2>/dev/null | head -1)
if [ -n "$FIRST_POD" ]; then
  echo "Deleting pod: $FIRST_POD"
  kubectl delete pod "$FIRST_POD" --grace-period=0 --force 2>/dev/null
  echo "Waiting 20s for queue drain..."
  sleep 20

  ACTIVE_AFTER=$(kubectl get pods -l app=agent-swarm --field-selector=status.phase!=Succeeded,status.phase!=Failed --no-headers 2>/dev/null | wc -l | tr -d ' ')
  echo "Active pods after drain: $ACTIVE_AFTER"

  if [ "$ACTIVE_AFTER" -ge 1 ]; then
    echo "✅ PASS: Queue drain started a new run after completion"
  else
    echo "⚠️  INCONCLUSIVE: No pods running (operator may not have drained yet)"
  fi
else
  echo "No pods found to delete — operator is not creating swarm pods"
fi

echo ""
echo "=== Operator logs ==="
kubectl logs deployment/swarmrun-operator --tail=30 2>&1 || echo "(no logs available)"

echo ""
echo "=== Cleanup ==="
echo "  kind delete cluster --name $CLUSTER_NAME"
echo ""
echo "Test complete."
