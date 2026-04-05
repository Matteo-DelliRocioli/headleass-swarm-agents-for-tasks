// ---------------------------------------------------------------------------
// Test helpers — mock factories for K8s API, BeadsQueue, StatusUpdater
// ---------------------------------------------------------------------------

import type { Config } from "../src/config";
import type { SwarmRun, SwarmRunPhase } from "../src/types";

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    namespace: "default",
    maxConcurrentRuns: 5,
    cleanupRetentionMinutes: 60,
    staleCheckIntervalMinutes: 5,
    periodicSyncSeconds: 60,
    images: {
      opencode: "swarm-opencode:test",
      orchestrator: "swarm-orchestrator:test",
      beads: "swarm-beads:test",
      playwright: "mcr.microsoft.com/playwright:test",
    },
    defaultResources: {
      opencode: { memory: "4Gi", cpu: "2" },
      orchestrator: { memory: "2Gi", cpu: "1" },
      beads: { memory: "1Gi", cpu: "0.5" },
      playwright: { memory: "2Gi", cpu: "1" },
    },
    ...overrides,
  };
}

export function makeSwarmRun(
  name: string,
  phase?: SwarmRunPhase,
  extra: Partial<SwarmRun> = {},
): SwarmRun {
  return {
    apiVersion: "swarm.agentswarm.io/v1alpha1",
    kind: "SwarmRun",
    metadata: {
      name,
      namespace: "default",
      ...extra.metadata,
    },
    spec: {
      prompt: `Build feature ${name}`,
      maxLoops: 3,
      confidenceThreshold: 0.85,
      model: "anthropic/claude-sonnet-4-20250514",
      gitBranch: "main",
      timeout: "2h",
      priority: 2,
      ...extra.spec,
    },
    status: phase
      ? {
          phase,
          beadsIssueId: `beads-${name}`,
          ...extra.status,
        }
      : extra.status,
  };
}

/** Mock K8s CoreV1Api with configurable pod list */
export function makeMockCoreApi(activePods: string[] = []) {
  const pods = activePods.map((name) => ({
    metadata: { name, labels: { app: "agent-swarm" } },
    status: { phase: "Running" },
  }));

  return {
    listNamespacedPod: async () => ({ items: pods }),
    createNamespacedPod: async () => ({}),
    readNamespacedPod: async ({ name }: { name: string }) => {
      const pod = pods.find((p) => p.metadata.name === name);
      if (!pod) throw new Error("404 Not Found");
      return pod;
    },
    deleteNamespacedPod: async () => ({}),
    _pods: pods, // Exposed for test manipulation
  };
}

/** Mock K8s CustomObjectsApi with configurable SwarmRun list */
export function makeMockCustomApi(swarmRuns: SwarmRun[] = []) {
  return {
    listNamespacedCustomObject: async () => ({ items: swarmRuns }),
    patchNamespacedCustomObject: async () => ({}),
    getNamespacedCustomObjectStatus: async () => ({
      status: { conditions: [] },
    }),
    patchNamespacedCustomObjectStatus: async () => ({}),
    _swarmRuns: swarmRuns, // Exposed for test manipulation
  };
}

/** Mock BeadsQueue */
export function makeMockBeadsQueue() {
  let inProgressCount = 0;

  return {
    createIssue: async (prompt: string) => `beads-${Date.now()}`,
    claimIssue: async () => true,
    closeIssue: async () => {},
    getReady: async () => [],
    countInProgress: async () => inProgressCount,
    setInProgressCount(n: number) { inProgressCount = n; },
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
  };
}

/** Mock StatusUpdater */
export function makeMockStatusUpdater() {
  const updates: Array<{ name: string; phase: string; extra?: Record<string, unknown> }> = [];
  const conditions: Array<{ name: string; condition: Record<string, unknown> }> = [];

  return {
    updatePhase: async (
      name: string,
      _ns: string,
      phase: string,
      extra?: Record<string, unknown>,
    ) => {
      updates.push({ name, phase, extra });
    },
    setCondition: async (
      name: string,
      _ns: string,
      condition: Record<string, unknown>,
    ) => {
      conditions.push({ name, condition });
    },
    getUpdates: () => updates,
    getConditions: () => conditions,
    reset: () => {
      updates.length = 0;
      conditions.length = 0;
    },
  };
}

/** Silent logger for tests */
export const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
