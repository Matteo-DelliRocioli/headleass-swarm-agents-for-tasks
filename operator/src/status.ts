// ---------------------------------------------------------------------------
// Status updater — patches SwarmRun CRD /status subresource
// ---------------------------------------------------------------------------

import * as k8s from "@kubernetes/client-node";
import type { Config } from "./config";
import type { SwarmRunPhase, SwarmRunStatus, K8sCondition } from "./types";

const CRD_GROUP = "swarm.agentswarm.io";
const CRD_VERSION = "v1alpha1";
const CRD_PLURAL = "swarmruns";

export class StatusUpdater {
  constructor(
    private readonly k8sApi: k8s.CustomObjectsApi,
    private readonly config: Config,
  ) {}

  /**
   * Update the phase of a SwarmRun and optionally merge extra status fields.
   */
  async updatePhase(
    name: string,
    namespace: string,
    phase: SwarmRunPhase,
    extra?: Partial<SwarmRunStatus>,
  ): Promise<void> {
    const statusPatch: Record<string, unknown> = {
      phase,
      ...extra,
    };

    await this.patchStatus(name, namespace, statusPatch);
  }

  /**
   * Add or update a condition on the SwarmRun status.
   */
  async setCondition(
    name: string,
    namespace: string,
    condition: K8sCondition,
  ): Promise<void> {
    // Read current status to merge conditions
    const current = await this.k8sApi.getNamespacedCustomObjectStatus({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace,
      plural: CRD_PLURAL,
      name,
    });

    const obj = current as Record<string, unknown>;
    const status = (obj.status ?? {}) as Record<string, unknown>;
    const conditions = ((status.conditions ?? []) as K8sCondition[]).filter(
      (c) => c.type !== condition.type,
    );
    conditions.push(condition);

    await this.patchStatus(name, namespace, { conditions });
  }

  private async patchStatus(
    name: string,
    namespace: string,
    statusFields: Record<string, unknown>,
  ): Promise<void> {
    const patch = {
      status: statusFields,
    };

    await (this.k8sApi as any).patchNamespacedCustomObjectStatus({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace,
      plural: CRD_PLURAL,
      name,
      body: patch,
    }, k8s.setHeaderOptions("Content-Type", "application/merge-patch+json"));
  }
}
