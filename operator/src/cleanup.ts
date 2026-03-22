// ---------------------------------------------------------------------------
// Cleanup manager — completed pods, stale runs, and orphans
// ---------------------------------------------------------------------------

import * as k8s from "@kubernetes/client-node";
import type { Config } from "./config";
import type { SwarmRun } from "./types";
import { logger } from "./logger";

export class CleanupManager {
  constructor(
    private readonly k8sApi: k8s.CoreV1Api,
    private readonly config: Config,
    private readonly log: typeof logger,
  ) {}

  /**
   * Delete pods that completed (Succeeded/Failed) more than
   * CLEANUP_RETENTION_MINUTES ago.
   */
  async cleanupCompletedPods(): Promise<void> {
    try {
      const response = await this.k8sApi.listNamespacedPod({
        namespace: this.config.namespace,
        labelSelector: "app=agent-swarm",
      });

      const now = Date.now();
      const retentionMs = this.config.cleanupRetentionMinutes * 60 * 1000;

      for (const pod of response.items ?? []) {
        const phase = pod.status?.phase;
        if (phase !== "Succeeded" && phase !== "Failed") {
          continue;
        }

        // Determine when the pod finished
        const finishedAt = this.getPodFinishTime(pod);
        if (!finishedAt) continue;

        const age = now - finishedAt.getTime();
        if (age > retentionMs) {
          const podName = pod.metadata?.name ?? "unknown";
          this.log.info("Cleaning up completed pod", {
            podName,
            phase,
            ageMinutes: Math.round(age / 60_000),
          });

          try {
            await this.k8sApi.deleteNamespacedPod({
              name: podName,
              namespace: this.config.namespace,
            });
          } catch (err) {
            this.log.warn("Failed to delete completed pod", {
              podName,
              error: String(err),
            });
          }
        }
      }
    } catch (err) {
      this.log.error("cleanupCompletedPods error", { error: String(err) });
    }
  }

  /**
   * Find SwarmRuns that are stale:
   *   - Running phase but timeout exceeded
   *   - Running phase but pod has disappeared
   */
  async detectStaleRuns(swarmRuns: SwarmRun[]): Promise<SwarmRun[]> {
    const stale: SwarmRun[] = [];

    for (const sr of swarmRuns) {
      if (sr.status?.phase !== "Running" && sr.status?.phase !== "Reviewing") {
        continue;
      }

      // Check timeout
      if (sr.status?.startTime) {
        const startTime = new Date(sr.status.startTime).getTime();
        const timeoutMs = this.parseTimeout(sr.spec.timeout);
        if (Date.now() - startTime > timeoutMs) {
          this.log.warn("Detected stale run (timeout exceeded)", {
            name: sr.metadata.name,
            startTime: sr.status.startTime,
            timeout: sr.spec.timeout,
          });
          stale.push(sr);
          continue;
        }
      }

      // Check if pod still exists
      const podName = sr.status?.podName ?? `swarm-run-${sr.metadata.name}`;
      const namespace = sr.metadata.namespace ?? this.config.namespace;
      try {
        await this.k8sApi.readNamespacedPod({ name: podName, namespace });
      } catch {
        this.log.warn("Detected stale run (pod missing)", {
          name: sr.metadata.name,
          podName,
        });
        stale.push(sr);
      }
    }

    return stale;
  }

  /**
   * Find and delete orphan pods — pods labelled app=agent-swarm that have
   * no matching SwarmRun resource.
   */
  async cleanupOrphans(swarmRuns: SwarmRun[]): Promise<void> {
    try {
      const response = await this.k8sApi.listNamespacedPod({
        namespace: this.config.namespace,
        labelSelector: "app=agent-swarm",
      });

      const knownRunNames = new Set(swarmRuns.map((sr) => sr.metadata.name));

      for (const pod of response.items ?? []) {
        const labels = pod.metadata?.labels ?? {};
        const runName = labels["swarm.agentswarm.io/run"];

        if (!runName || knownRunNames.has(runName)) {
          continue;
        }

        const podName = pod.metadata?.name ?? "unknown";
        this.log.warn("Deleting orphan pod", { podName, runName });

        try {
          await this.k8sApi.deleteNamespacedPod({
            name: podName,
            namespace: this.config.namespace,
          });
        } catch (err) {
          this.log.warn("Failed to delete orphan pod", {
            podName,
            error: String(err),
          });
        }
      }
    } catch (err) {
      this.log.error("cleanupOrphans error", { error: String(err) });
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private getPodFinishTime(pod: k8s.V1Pod): Date | null {
    const containerStatuses = [
      ...(pod.status?.containerStatuses ?? []),
      ...(pod.status?.initContainerStatuses ?? []),
    ];

    let latest: Date | null = null;

    for (const cs of containerStatuses) {
      const finished = cs.state?.terminated?.finishedAt;
      if (finished) {
        const d = new Date(finished);
        if (!latest || d > latest) {
          latest = d;
        }
      }
    }

    return latest;
  }

  private parseTimeout(timeout: string): number {
    const match = timeout.match(/^(\d+)(h|m|s)$/);
    if (!match) return 2 * 60 * 60 * 1000;
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
