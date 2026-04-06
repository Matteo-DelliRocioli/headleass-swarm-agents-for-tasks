// ---------------------------------------------------------------------------
// Concurrency controller — enforces MAX_CONCURRENT_RUNS
// ---------------------------------------------------------------------------

import * as k8s from "@kubernetes/client-node";
import type { Config } from "./config.js";
import { BeadsQueue } from "./beads-queue.js";

export interface ActiveCounts {
  pods: number;
  beads: number;
  effective: number;
}

export class ConcurrencyController {
  constructor(
    private readonly k8sApi: k8s.CoreV1Api,
    private readonly beadsQueue: BeadsQueue,
    private readonly config: Config,
  ) {}

  /**
   * Try to acquire a concurrency slot.
   * Returns true when there is room for another run.
   */
  async tryAcquireSlot(): Promise<boolean> {
    const counts = await this.getActiveCount();
    return counts.effective < this.config.maxConcurrentRuns;
  }

  /**
   * Return the number of active runs measured both via K8s pods and Beads
   * in-progress issues. The effective count is the higher of the two
   * (conservative approach).
   */
  async getActiveCount(): Promise<ActiveCounts> {
    const [pods, beads] = await Promise.all([
      this.countActivePods(),
      this.beadsQueue.countInProgress(),
    ]);

    return {
      pods,
      beads,
      effective: Math.max(pods, beads),
    };
  }

  private async countActivePods(): Promise<number> {
    const response = await this.k8sApi.listNamespacedPod({
      namespace: this.config.namespace,
      labelSelector: "app=agent-swarm",
    });
    const activePods = (response.items ?? []).filter((pod) => {
      const phase = pod.status?.phase;
      return phase !== "Succeeded" && phase !== "Failed";
    });
    return activePods.length;
  }
}
