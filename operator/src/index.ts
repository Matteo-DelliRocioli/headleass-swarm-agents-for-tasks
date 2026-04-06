// ---------------------------------------------------------------------------
// Entry point — wires all operator components together
// ---------------------------------------------------------------------------

import * as k8s from "@kubernetes/client-node";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { BeadsQueue } from "./beads-queue.js";
import { ConcurrencyController } from "./concurrency.js";
import { StatusUpdater } from "./status.js";
import { Reconciler } from "./reconciler.js";
import { CleanupManager } from "./cleanup.js";
import { SwarmWatcher } from "./watcher.js";

async function main(): Promise<void> {
  logger.info("SwarmRun Operator starting", {
    config: {
      namespace: config.namespace,
      maxConcurrentRuns: config.maxConcurrentRuns,
      cleanupRetentionMinutes: config.cleanupRetentionMinutes,
      staleCheckIntervalMinutes: config.staleCheckIntervalMinutes,
      periodicSyncSeconds: config.periodicSyncSeconds,
      images: config.images,
      // Secrets intentionally omitted
    },
  });

  // Initialize K8s clients
  const kc = new k8s.KubeConfig();

  // Use in-cluster config when running inside a pod, otherwise fall back to
  // the default kubeconfig (developer workstation).
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
    logger.info("Loaded in-cluster kubeconfig");
  } else {
    kc.loadFromDefault();
    logger.info("Loaded default kubeconfig");
  }

  const k8sCore = kc.makeApiClient(k8s.CoreV1Api);
  const k8sCustom = kc.makeApiClient(k8s.CustomObjectsApi);
  // ApiextensionsV1Api kept available for future CRD auto-apply
  const _k8sApiext = kc.makeApiClient(k8s.ApiextensionsV1Api);

  // Initialize components
  const beadsQueue = new BeadsQueue(logger);
  const concurrency = new ConcurrencyController(k8sCore, beadsQueue, config);
  const statusUpdater = new StatusUpdater(k8sCustom, config);
  const reconciler = new Reconciler(
    k8sCore,
    k8sCustom,
    beadsQueue,
    concurrency,
    statusUpdater,
    config,
    logger,
  );
  const _cleanup = new CleanupManager(k8sCore, config, logger);
  const watcher = new SwarmWatcher(kc, reconciler, config, logger);

  // Start watching
  await watcher.start();
  logger.info("SwarmRun Operator is running");

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    await watcher.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) });
  process.exit(1);
});
