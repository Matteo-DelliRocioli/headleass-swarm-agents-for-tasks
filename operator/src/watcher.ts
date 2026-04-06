// ---------------------------------------------------------------------------
// Watcher — K8s informers for SwarmRun CRDs and agent-swarm pods
// ---------------------------------------------------------------------------

import * as k8s from "@kubernetes/client-node";
import type { Config } from "./config.js";
import type { SwarmRun } from "./types.js";
import { Reconciler } from "./reconciler.js";
import { logger } from "./logger.js";

const CRD_GROUP = "swarm.agentswarm.io";
const CRD_VERSION = "v1alpha1";
const CRD_PLURAL = "swarmruns";

export class SwarmWatcher {
  private swarmRunInformer: k8s.Informer<k8s.KubernetesObject> | null = null;
  private podInformer: k8s.Informer<k8s.V1Pod> | null = null;
  private periodicSyncTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly k8sConfig: k8s.KubeConfig,
    private readonly reconciler: Reconciler,
    private readonly config: Config,
    private readonly log: typeof logger,
  ) {}

  async start(): Promise<void> {
    this.log.info("Starting SwarmWatcher");

    // Watch SwarmRun CRDs
    await this.watchSwarmRuns();

    // Watch pods with label app=agent-swarm
    await this.watchPods();

    // Periodic full sync
    this.periodicSyncTimer = setInterval(
      () => this.periodicSync(),
      this.config.periodicSyncSeconds * 1000,
    );

    // Stale run detection
    this.staleCheckTimer = setInterval(
      () => this.staleCheck(),
      this.config.staleCheckIntervalMinutes * 60 * 1000,
    );

    this.log.info("SwarmWatcher started", {
      periodicSyncSeconds: this.config.periodicSyncSeconds,
      staleCheckIntervalMinutes: this.config.staleCheckIntervalMinutes,
    });
  }

  async stop(): Promise<void> {
    this.log.info("Stopping SwarmWatcher");
    this.stopped = true;

    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = null;
    }

    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }

    if (this.swarmRunInformer) {
      await this.swarmRunInformer.stop();
      this.swarmRunInformer = null;
    }

    if (this.podInformer) {
      await this.podInformer.stop();
      this.podInformer = null;
    }

    this.log.info("SwarmWatcher stopped");
  }

  // -----------------------------------------------------------------------
  // SwarmRun CRD informer
  // -----------------------------------------------------------------------

  private async watchSwarmRuns(): Promise<void> {
    const path = `/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${this.config.namespace}/${CRD_PLURAL}`;

    this.swarmRunInformer = k8s.makeInformer(
      this.k8sConfig,
      path,
      async () => {
        const k8sCustom = this.k8sConfig.makeApiClient(k8s.CustomObjectsApi);
        const response = await k8sCustom.listNamespacedCustomObject({
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace: this.config.namespace,
          plural: CRD_PLURAL,
        });
        return response as k8s.KubernetesListObject<k8s.KubernetesObject>;
      },
    );

    this.swarmRunInformer.on("add", (obj: k8s.KubernetesObject) => {
      this.onSwarmRunEvent("add", obj);
    });

    this.swarmRunInformer.on("update", (obj: k8s.KubernetesObject) => {
      this.onSwarmRunEvent("update", obj);
    });

    this.swarmRunInformer.on("delete", (obj: k8s.KubernetesObject) => {
      this.onSwarmRunEvent("delete", obj);
    });

    this.swarmRunInformer.on("error", (err: unknown) => {
      this.log.error("SwarmRun informer error", { error: String(err) });
      // Restart after a brief delay unless stopped
      if (!this.stopped) {
        setTimeout(() => this.watchSwarmRuns(), 5000);
      }
    });

    await this.swarmRunInformer.start();
  }

  private onSwarmRunEvent(event: string, obj: k8s.KubernetesObject): void {
    const swarmRun = obj as unknown as SwarmRun;
    this.log.debug("SwarmRun event", {
      event,
      name: swarmRun.metadata?.name,
      phase: swarmRun.status?.phase,
    });

    this.reconciler.reconcile(swarmRun).catch((err) => {
      this.log.error("Reconcile failed after SwarmRun event", {
        event,
        name: swarmRun.metadata?.name,
        error: String(err),
      });
    });
  }

  // -----------------------------------------------------------------------
  // Pod informer
  // -----------------------------------------------------------------------

  private async watchPods(): Promise<void> {
    const path = `/api/v1/namespaces/${this.config.namespace}/pods`;

    this.podInformer = k8s.makeInformer(
      this.k8sConfig,
      path,
      async () => {
        const k8sCore = this.k8sConfig.makeApiClient(k8s.CoreV1Api);
        const response = await k8sCore.listNamespacedPod({
          namespace: this.config.namespace,
          labelSelector: "app=agent-swarm",
        });
        return response;
      },
    );

    this.podInformer.on("add", (pod: k8s.V1Pod) => {
      this.onPodEvent("add", pod);
    });

    this.podInformer.on("update", (pod: k8s.V1Pod) => {
      this.onPodEvent("update", pod);
    });

    this.podInformer.on("delete", (pod: k8s.V1Pod) => {
      this.onPodEvent("delete", pod);
    });

    this.podInformer.on("error", (err: unknown) => {
      this.log.error("Pod informer error", { error: String(err) });
      if (!this.stopped) {
        setTimeout(() => this.watchPods(), 5000);
      }
    });

    await this.podInformer.start();
  }

  private onPodEvent(event: string, pod: k8s.V1Pod): void {
    const labels = pod.metadata?.labels ?? {};
    const runName = labels["swarm.agentswarm.io/run"];

    if (!runName) {
      return;
    }

    this.log.debug("Pod event for SwarmRun", {
      event,
      podName: pod.metadata?.name,
      runName,
      phase: pod.status?.phase,
    });

    // Fetch the SwarmRun and reconcile it
    this.fetchAndReconcile(runName).catch((err) => {
      this.log.error("Reconcile failed after pod event", {
        event,
        podName: pod.metadata?.name,
        runName,
        error: String(err),
      });
    });
  }

  // -----------------------------------------------------------------------
  // Periodic tasks
  // -----------------------------------------------------------------------

  private async periodicSync(): Promise<void> {
    if (this.stopped) return;

    this.log.debug("Periodic sync started");

    try {
      const k8sCustom = this.k8sConfig.makeApiClient(k8s.CustomObjectsApi);
      const response = await k8sCustom.listNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: this.config.namespace,
        plural: CRD_PLURAL,
      });

      const list = response as { items?: SwarmRun[] };
      const items = list.items ?? [];

      for (const swarmRun of items) {
        if (this.stopped) break;
        await this.reconciler.reconcile(swarmRun);
      }

      // Also attempt to drain the queue
      await this.reconciler.drainQueue();
    } catch (err) {
      this.log.error("Periodic sync error", { error: String(err) });
    }
  }

  private async staleCheck(): Promise<void> {
    if (this.stopped) return;

    this.log.debug("Stale check started");

    try {
      const k8sCustom = this.k8sConfig.makeApiClient(k8s.CustomObjectsApi);
      const response = await k8sCustom.listNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: this.config.namespace,
        plural: CRD_PLURAL,
      });

      const list = response as { items?: SwarmRun[] };
      const items = list.items ?? [];

      // Reconcile running items — the reconciler itself handles timeout detection
      const running = items.filter(
        (sr) => sr.status?.phase === "Running" || sr.status?.phase === "Reviewing",
      );

      for (const sr of running) {
        if (this.stopped) break;
        await this.reconciler.reconcile(sr);
      }
    } catch (err) {
      this.log.error("Stale check error", { error: String(err) });
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async fetchAndReconcile(name: string): Promise<void> {
    const k8sCustom = this.k8sConfig.makeApiClient(k8s.CustomObjectsApi);
    const response = await k8sCustom.getNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: this.config.namespace,
      plural: CRD_PLURAL,
      name,
    });

    const swarmRun = response as unknown as SwarmRun;
    await this.reconciler.reconcile(swarmRun);
  }
}
