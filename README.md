# Headless Swarm Agents for Tasks

A Kubernetes-native system that orchestrates a swarm of AI agents to autonomously implement, review, and iterate on software tasks. Each agent runs as a persona-driven session inside an [OpenCode](https://opencode.ai) instance, coordinated by a loop controller that manages task decomposition, parallel review, confidence scoring, and shared memory.

## Architecture

```
User prompt
    |
    v
[K8s Operator] ──watches SwarmRun CRDs──> [Reconciler]
    |                                          |
    | creates pod                               | concurrency mutex
    v                                          v
[Sidecar Pod]                            [Queue Drain]
  ├── OpenCode (AI backend)                    |
  ├── Orchestrator (loop controller)           | max 5 concurrent
  ├── Beads (task tracking)                    |
  └── Playwright (functional testing)     [Queued runs wait]
```

### Inside the Pod — Orchestrator Loop

```
Phase 1: Plan ──> Planner Agent decomposes prompt into tasks
           |         ↕ (iterative review with master-reviewer, max 10 loops)
           v
Phase 2: Implement ──> Persona-matched agents execute tasks in parallel
           |
Phase 3: Review ──> 4 reviewers (security, quality, architecture, QA) score in parallel
           |
Phase 4: Score ──> Weighted confidence aggregation
           |
           ├── confidence >= threshold? ──> Done
           ├── follow-up tasks? ──> Create tasks, loop back to Phase 2
           └── max loops? ──> Hard stop, defer remaining tasks
```

## Components

| Directory | What | Key Files |
|---|---|---|
| `operator/` | K8s operator — watches SwarmRun CRDs, manages pod lifecycle, enforces concurrency (mutex-protected) | `reconciler.ts`, `concurrency.ts`, `pod-template.ts` |
| `orchestrator/` | In-pod loop controller — plans, spawns agents, aggregates reviews, tracks costs | `index.ts`, `agent-spawner.ts`, `review-aggregator.ts`, `mem0.ts` |
| `personas/` | 11 agent persona definitions — implementors, reviewers, planner, QA evaluator | `*.md` with YAML frontmatter |
| `opencode-config/` | Custom tools + plugin for agents inside OpenCode | `tools/`, `plugins/swarm-guard.ts` |

### Personas (11 total)

**Implementors** (write code): `frontend-dev`, `backend-dev`, `devops-agent`, `test-writer`, `database-specialist`

**Reviewers** (read-only, calibrated scoring): `security-reviewer`, `quality-reviewer`, `architecture-reviewer`, `qa-evaluator` (Playwright MCP)

**Coordinators**: `planner-agent` (task decomposition), `master-reviewer` (score aggregation, verdict)

## Prerequisites

- Node.js 20+
- Docker (for building images)
- kind (for local K8s testing)
- kubectl

## Quick Start — Local Development

```bash
# 1. Install dependencies
cd operator && npm install && cd ..
cd orchestrator && npm install && cd ..

# 2. Run operator unit tests
cd operator && npm test

# 3. Build and run the kind integration test
./operator/test/kind-concurrency-test.sh
```

## Deploying to Kubernetes

```bash
# 1. Build images
cd operator && npm run build && cd ..
docker build -f operator/images/operator/Dockerfile -t swarmrun-operator:latest .

# 2. Apply manifests
kubectl apply -f operator/manifests/crd-swarmrun.yaml
kubectl apply -f operator/manifests/operator-rbac.yaml
kubectl apply -f operator/manifests/swarm-runner-rbac.yaml
kubectl apply -f operator/manifests/operator-configmap.yaml
kubectl apply -f operator/manifests/operator-deployment.yaml

# 3. Submit a swarm run
cat <<EOF | kubectl apply -f -
apiVersion: swarm.agentswarm.io/v1alpha1
kind: SwarmRun
metadata:
  name: my-feature
spec:
  prompt: "Add user authentication with JWT tokens and refresh flow"
  maxLoops: 3
  confidenceThreshold: 0.85
  timeout: "2h"
  priority: 1
EOF

# 4. Watch progress
kubectl get swarmruns -w
```

## Configuration

### Operator (via ConfigMap or env vars)

| Variable | Default | Description |
|---|---|---|
| `MAX_CONCURRENT_RUNS` | `5` | Max simultaneous swarm pods |
| `CLEANUP_RETENTION_MINUTES` | `60` | How long to keep completed pods |
| `PERIODIC_SYNC_SECONDS` | `60` | Reconcile interval |

### Orchestrator (via env vars in pod)

| Variable | Default | Description |
|---|---|---|
| `SWARM_INITIAL_PROMPT` | (required) | The task to accomplish |
| `SWARM_MAX_LOOPS` | `3` | Max implement→review cycles |
| `SWARM_CONFIDENCE_THRESHOLD` | `0.85` | Score to auto-approve |
| `SWARM_MAX_PLAN_LOOPS` | `3` | Max plan→review iterations (hard cap: 10) |
| `SWARM_MODEL` | `anthropic/claude-sonnet-4-20250514` | Model for agents |
| `MEM0_API_URL` | `http://localhost:8080` | Mem0 server for shared memory |

## How Review Scoring Works

Each reviewer outputs a score (0-1) and issues list. The aggregator applies weights:

- Security: 1.5x (vulnerabilities are critical)
- QA Evaluator: 1.4x (functional bugs matter most)
- Architecture: 1.2x (structural issues compound)
- Quality: 1.0x (maintainability baseline)

**Hard rules**: Any `critical` issue from any reviewer forces FAIL regardless of composite score. Composite must exceed 0.7 threshold. Missing reviewers reduce confidence by 0.2 each.

All reviewers include calibrated few-shot examples that anchor score ranges — preventing the common failure mode where LLMs identify real issues but rationalize them away.

## Custom Tools Available to Agents

| Tool | Purpose |
|---|---|
| `beads-claim` | Claim a task before starting work |
| `beads-close` | Mark a task complete |
| `beads-ready` | List available tasks |
| `swarm-send` | Send message to another agent |
| `swarm-receive` | Read pending messages |
| `swarm-status` | Query swarm state |
| `mem0-remember` | Store a memory for other agents |
| `mem0-recall` | Search shared memories |

## License

Apache License 2.0 — see [LICENSE](LICENSE).
