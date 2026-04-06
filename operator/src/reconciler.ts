// ---------------------------------------------------------------------------
// Reconciler — the core state machine for SwarmRun resources
// ---------------------------------------------------------------------------

import * as k8s from "@kubernetes/client-node";
import type { Config } from "./config.js";
import type { SwarmRun, SwarmRunResults } from "./types.js";
import { SwarmRunResultsSchema } from "./types.js";
import { BeadsQueue } from "./beads-queue.js";
import { ConcurrencyController } from "./concurrency.js";
import { StatusUpdater } from "./status.js";
import { buildSwarmPod } from "./pod-template.js";
import { classifyError } from "./errors.js";
import { logger } from "./logger.js";

const CRD_GROUP = "swarm.agentswarm.io";
const CRD_VERSION = "v1alpha1";
const CRD_PLURAL = "swarmruns";
const FINALIZER = "swarm.agentswarm.io/cleanup";

export class Reconciler {
  constructor(
    private readonly k8sCore: k8s.CoreV1Api,
    private readonly k8sCustom: k8s.CustomObjectsApi,
    private readonly beadsQueue: BeadsQueue,
    private readonly concurrency: ConcurrencyController,
    private readonly statusUpdater: StatusUpdater,
    private readonly config: Config,
    private readonly log: typeof logger,
  ) {}

  // In-flight guards to prevent duplicate processing from rapid event delivery
  private readonly inflight = new Set<string>();

  // Serializes drainQueue so that tryAcquireSlot + createPod is atomic
  private drainMutex: Promise<void> = Promise.resolve();

  // -----------------------------------------------------------------------
  // Main reconcile loop
  // -----------------------------------------------------------------------

  async reconcile(swarmRun: SwarmRun): Promise<void> {
    const name = swarmRun.metadata.name;
    const namespace = swarmRun.metadata.namespace ?? this.config.namespace;

    // Guard: skip if this SwarmRun is already being reconciled
    if (this.inflight.has(name)) {
      this.log.debug("Skipping duplicate reconcile", { name });
      return;
    }
    this.inflight.add(name);

    try {
      // 1. Deletion — handle finalizer
      if (this.isBeingDeleted(swarmRun)) {
        await this.handleDeletion(swarmRun, name, namespace);
        return;
      }

      // 2. No beadsIssueId — first time seen, create issue and enqueue
      if (!swarmRun.status?.beadsIssueId) {
        await this.handleNew(swarmRun, name, namespace);
        await this.drainQueue();
        return;
      }

      const phase = swarmRun.status?.phase;

      // 3. Queued — try to acquire a slot
      if (phase === "Queued") {
        await this.handleQueued(swarmRun, name, namespace);
        return;
      }

      // 4. Running or Reviewing — watch for completion
      if (phase === "Running" || phase === "Reviewing") {
        await this.handleRunning(swarmRun, name, namespace);
        return;
      }

      // 5. Terminal states — no-op
      if (phase === "Completed" || phase === "Failed" || phase === "TimedOut") {
        return;
      }

      this.log.warn("SwarmRun in unknown phase", { name, phase });
    } catch (err) {
      const classified = classifyError(err);
      this.log.error("Reconcile error", {
        name,
        category: classified.category,
        retryable: classified.retryable,
        message: classified.message,
      });
    } finally {
      this.inflight.delete(name);
    }
  }

  // -----------------------------------------------------------------------
  // Drain queue — attempt to start queued runs
  // -----------------------------------------------------------------------

  async drainQueue(): Promise<void> {
    // Chain onto the mutex so only one drain runs at a time
    const prev = this.drainMutex;
    let release!: () => void;
    this.drainMutex = new Promise<void>((resolve) => { release = resolve; });
    await prev;

    try {
      await this._drainQueue();
    } finally {
      release();
    }
  }

  private async _drainQueue(): Promise<void> {
    try {
      const response = await this.k8sCustom.listNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: this.config.namespace,
        plural: CRD_PLURAL,
      });

      const list = response as { items?: SwarmRun[] };
      const queued = (list.items ?? [])
        .filter((sr) => sr.status?.phase === "Queued")
        .sort((a, b) => (a.spec.priority ?? 2) - (b.spec.priority ?? 2));

      for (const sr of queued) {
        const hasSlot = await this.concurrency.tryAcquireSlot();
        if (!hasSlot) {
          this.log.info("No concurrency slots available, stopping queue drain");
          break;
        }
        await this._startQueued(
          sr,
          sr.metadata.name,
          sr.metadata.namespace ?? this.config.namespace,
        );
      }
    } catch (err) {
      this.log.error("drainQueue error", { error: String(err) });
    }
  }

  // -----------------------------------------------------------------------
  // State handlers
  // -----------------------------------------------------------------------

  private isBeingDeleted(swarmRun: SwarmRun): boolean {
    const annotations = swarmRun.metadata.annotations ?? {};
    return annotations["deletionTimestamp"] !== undefined ||
      (swarmRun as Record<string, unknown>).deletionTimestamp !== undefined;
  }

  private async handleDeletion(
    swarmRun: SwarmRun,
    name: string,
    namespace: string,
  ): Promise<void> {
    this.log.info("Handling deletion", { name });

    // Delete the pod if it exists
    try {
      await this.k8sCore.deleteNamespacedPod({
        name: `swarm-run-${name}`,
        namespace,
      });
    } catch {
      // Pod may already be gone
    }

    // Close the Beads issue
    if (swarmRun.status?.beadsIssueId) {
      try {
        await this.beadsQueue.closeIssue(swarmRun.status.beadsIssueId, "SwarmRun deleted");
      } catch {
        // Best effort
      }
    }

    // Remove finalizer
    await this.removeFinalizer(name, namespace);
    await this.drainQueue();
  }

  private async handleNew(
    swarmRun: SwarmRun,
    name: string,
    namespace: string,
  ): Promise<void> {
    this.log.info("New SwarmRun, creating Beads issue", { name });

    const issueId = await this.beadsQueue.createIssue(
      swarmRun.spec.prompt,
      swarmRun.spec.priority,
    );

    // Add finalizer
    await this.addFinalizer(name, namespace);

    // Set phase to Queued
    await this.statusUpdater.updatePhase(name, namespace, "Queued", {
      beadsIssueId: issueId,
    });
  }

  private async handleQueued(
    swarmRun: SwarmRun,
    name: string,
    namespace: string,
  ): Promise<void> {
    // Route through the drain mutex so slot acquisition is serialized
    const prev = this.drainMutex;
    let release!: () => void;
    this.drainMutex = new Promise<void>((resolve) => { release = resolve; });
    await prev;

    try {
      const hasSlot = await this.concurrency.tryAcquireSlot();
      if (!hasSlot) {
        this.log.debug("No slot available for queued run", { name });
        return;
      }
      await this._startQueued(swarmRun, name, namespace);
    } finally {
      release();
    }
  }

  /** Create the pod and update status. Caller must hold drainMutex. */
  private async _startQueued(
    swarmRun: SwarmRun,
    name: string,
    namespace: string,
  ): Promise<void> {
    this.log.info("Slot available, claiming and starting run", { name });

    // Claim the Beads issue
    const issueId = swarmRun.status?.beadsIssueId;
    if (issueId) {
      const claimed = await this.beadsQueue.claimIssue(issueId);
      if (!claimed) {
        this.log.warn("Failed to claim Beads issue", { name, issueId });
        return;
      }
    }

    // Create the sidecar pod (ignore 409 AlreadyExists from duplicate events)
    const pod = buildSwarmPod(swarmRun, this.config);
    try {
      await this.k8sCore.createNamespacedPod({
        namespace,
        body: pod,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("409") || msg.includes("AlreadyExists")) {
        this.log.info("Pod already exists, continuing", { name });
      } else {
        throw err;
      }
    }

    // Update status to Running
    await this.statusUpdater.updatePhase(name, namespace, "Running", {
      podName: `swarm-run-${name}`,
      startTime: new Date().toISOString(),
    });

    await this.statusUpdater.setCondition(name, namespace, {
      type: "PodCreated",
      status: "True",
      lastTransitionTime: new Date().toISOString(),
      reason: "PodScheduled",
      message: `Pod swarm-run-${name} created`,
    });
  }

  private async handleRunning(
    swarmRun: SwarmRun,
    name: string,
    namespace: string,
  ): Promise<void> {
    const podName = swarmRun.status?.podName ?? `swarm-run-${name}`;

    // Try to get the pod
    let pod: k8s.V1Pod;
    try {
      pod = await this.k8sCore.readNamespacedPod({ name: podName, namespace });
    } catch {
      // Pod is gone
      this.log.error("Pod missing for running SwarmRun", { name, podName });
      if (swarmRun.status?.beadsIssueId) {
        await this.beadsQueue.closeIssue(swarmRun.status.beadsIssueId, "Pod disappeared");
      }
      await this.statusUpdater.updatePhase(name, namespace, "Failed", {
        completionTime: new Date().toISOString(),
        message: "Pod disappeared unexpectedly",
      });
      await this.drainQueue();
      return;
    }

    // Find orchestrator container status
    const containerStatuses = pod.status?.containerStatuses ?? [];
    const orchestrator = containerStatuses.find((cs) => cs.name === "orchestrator");

    if (!orchestrator) {
      this.log.debug("Orchestrator container status not yet available", { name });
      return;
    }

    // Check for termination
    const terminated = orchestrator.state?.terminated;
    if (terminated) {
      if (terminated.exitCode === 0) {
        await this.handleOrchestratorSuccess(swarmRun, name, namespace, pod);
      } else {
        await this.handleOrchestratorFailure(swarmRun, name, namespace, terminated);
      }
      return;
    }

    // Still running — check timeout
    if (swarmRun.status?.startTime) {
      const startTime = new Date(swarmRun.status.startTime).getTime();
      const timeoutMs = this.parseTimeout(swarmRun.spec.timeout);
      if (Date.now() - startTime > timeoutMs) {
        this.log.warn("SwarmRun timed out", { name });
        if (swarmRun.status.beadsIssueId) {
          await this.beadsQueue.closeIssue(swarmRun.status.beadsIssueId, "Timed out");
        }
        await this.statusUpdater.updatePhase(name, namespace, "TimedOut", {
          completionTime: new Date().toISOString(),
          message: `Timed out after ${swarmRun.spec.timeout}`,
        });
        // Delete the pod
        try {
          await this.k8sCore.deleteNamespacedPod({ name: podName, namespace });
        } catch {
          // Best effort
        }
        await this.drainQueue();
        return;
      }
    }

    // Check annotations for progress updates
    const annotations = pod.metadata?.annotations ?? {};
    const loopStr = annotations["swarm.agentswarm.io/current-loop"];
    const confStr = annotations["swarm.agentswarm.io/confidence"];
    if (loopStr || confStr) {
      const extra: Record<string, unknown> = {};
      if (loopStr) extra.currentLoop = parseInt(loopStr, 10);
      if (confStr) extra.confidence = parseFloat(confStr);
      await this.statusUpdater.updatePhase(
        name,
        namespace,
        swarmRun.status?.phase ?? "Running",
        extra,
      );
    }
  }

  private async handleOrchestratorSuccess(
    swarmRun: SwarmRun,
    name: string,
    namespace: string,
    pod: k8s.V1Pod,
  ): Promise<void> {
    this.log.info("Orchestrator completed successfully", { name });

    let results: SwarmRunResults | undefined;

    // Try to read termination message
    const containerStatuses = pod.status?.containerStatuses ?? [];
    const orchestrator = containerStatuses.find((cs) => cs.name === "orchestrator");
    const terminationMessage = orchestrator?.state?.terminated?.message;

    if (terminationMessage) {
      try {
        // Expected format: SWARM_RUN_COMPLETE:<json>
        const prefix = "SWARM_RUN_COMPLETE:";
        const jsonStr = terminationMessage.startsWith(prefix)
          ? terminationMessage.slice(prefix.length)
          : terminationMessage;
        results = SwarmRunResultsSchema.parse(JSON.parse(jsonStr));
      } catch (err) {
        this.log.warn("Failed to parse termination message", {
          name,
          message: terminationMessage,
          error: String(err),
        });
      }
    }

    // Close Beads issue
    if (swarmRun.status?.beadsIssueId) {
      await this.beadsQueue.closeIssue(swarmRun.status.beadsIssueId, "Completed successfully");
    }

    // Update status
    await this.statusUpdater.updatePhase(name, namespace, "Completed", {
      completionTime: new Date().toISOString(),
      message: "Swarm run completed successfully",
      results,
    });

    // Delete the pod
    const podName = swarmRun.status?.podName ?? `swarm-run-${name}`;
    try {
      await this.k8sCore.deleteNamespacedPod({ name: podName, namespace });
    } catch {
      // Best effort
    }

    await this.drainQueue();
  }

  private async handleOrchestratorFailure(
    swarmRun: SwarmRun,
    name: string,
    namespace: string,
    terminated: k8s.V1ContainerStateTerminated,
  ): Promise<void> {
    this.log.error("Orchestrator failed", {
      name,
      exitCode: terminated.exitCode,
      reason: terminated.reason,
    });

    // Close Beads issue
    if (swarmRun.status?.beadsIssueId) {
      await this.beadsQueue.closeIssue(
        swarmRun.status.beadsIssueId,
        `Failed: exit code ${terminated.exitCode}`,
      );
    }

    // Update status
    await this.statusUpdater.updatePhase(name, namespace, "Failed", {
      completionTime: new Date().toISOString(),
      message: `Orchestrator exited with code ${terminated.exitCode}: ${terminated.reason ?? "unknown"}`,
    });

    // Delete the pod
    const podName = swarmRun.status?.podName ?? `swarm-run-${name}`;
    try {
      await this.k8sCore.deleteNamespacedPod({ name: podName, namespace });
    } catch {
      // Best effort
    }

    await this.drainQueue();
  }

  // -----------------------------------------------------------------------
  // Finalizer helpers
  // -----------------------------------------------------------------------

  private async addFinalizer(name: string, namespace: string): Promise<void> {
    const patch = [
      {
        op: "add",
        path: "/metadata/finalizers",
        value: [FINALIZER],
      },
    ];

    await (this.k8sCustom as any).patchNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace,
      plural: CRD_PLURAL,
      name,
      body: patch,
    }, k8s.setHeaderOptions("Content-Type", "application/json-patch+json"));
  }

  private async removeFinalizer(name: string, namespace: string): Promise<void> {
    const patch = [
      {
        op: "remove",
        path: "/metadata/finalizers",
      },
    ];

    try {
      await (this.k8sCustom as any).patchNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace,
        plural: CRD_PLURAL,
        name,
        body: patch,
      }, k8s.setHeaderOptions("Content-Type", "application/json-patch+json"));
    } catch {
      // Resource may already be gone
    }
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private parseTimeout(timeout: string): number {
    const match = timeout.match(/^(\d+)(h|m|s)$/);
    if (!match) return 2 * 60 * 60 * 1000; // default 2h
    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case "h":
        return value * 60 * 60 * 1000;
      case "m":
        return value * 60 * 1000;
      case "s":
        return value * 1000;
      default:
        return 2 * 60 * 60 * 1000;
    }
  }
}
