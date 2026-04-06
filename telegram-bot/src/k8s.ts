// ---------------------------------------------------------------------------
// K8s client for SwarmRun CRD operations
// ---------------------------------------------------------------------------

import * as k8s from "@kubernetes/client-node";

const CRD_GROUP = "swarm.agentswarm.io";
const CRD_VERSION = "v1alpha1";
const CRD_PLURAL = "swarmruns";

export interface SwarmRunSummary {
  name: string;
  phase: string;
  currentLoop?: number;
  maxLoops?: number;
  confidence?: number;
  startTime?: string;
  completionTime?: string;
  message?: string;
  podName?: string;
}

export class K8sClient {
  private customApi: k8s.CustomObjectsApi;
  private namespace: string;

  constructor(namespace = "default") {
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.namespace = namespace;
  }

  async createSwarmRun(opts: {
    name: string;
    prompt: string;
    maxLoops?: number;
    confidenceThreshold?: number;
    priority?: number;
    model?: string;
    timeout?: string;
  }): Promise<string> {
    const body = {
      apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
      kind: "SwarmRun",
      metadata: { name: opts.name, namespace: this.namespace },
      spec: {
        prompt: opts.prompt,
        maxLoops: opts.maxLoops ?? 3,
        confidenceThreshold: opts.confidenceThreshold ?? 0.85,
        priority: opts.priority ?? 2,
        model: opts.model ?? "anthropic/claude-sonnet-4-20250514",
        timeout: opts.timeout ?? "2h",
      },
    };

    await this.customApi.createNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: this.namespace,
      plural: CRD_PLURAL,
      body,
    });

    return opts.name;
  }

  async deleteSwarmRun(name: string): Promise<void> {
    await this.customApi.deleteNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: this.namespace,
      plural: CRD_PLURAL,
      name,
    });
  }

  async listSwarmRuns(): Promise<SwarmRunSummary[]> {
    const response = await this.customApi.listNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: this.namespace,
      plural: CRD_PLURAL,
    });

    const list = response as { items?: Array<Record<string, any>> };
    return (list.items ?? []).map((item) => ({
      name: item.metadata?.name ?? "",
      phase: item.status?.phase ?? "Unknown",
      currentLoop: item.status?.currentLoop,
      maxLoops: item.spec?.maxLoops,
      confidence: item.status?.confidence,
      startTime: item.status?.startTime,
      completionTime: item.status?.completionTime,
      message: item.status?.message,
      podName: item.status?.podName,
    }));
  }

  async getSwarmRun(name: string): Promise<SwarmRunSummary | null> {
    try {
      const response = await this.customApi.getNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: this.namespace,
        plural: CRD_PLURAL,
        name,
      });

      const item = response as Record<string, any>;
      return {
        name: item.metadata?.name ?? name,
        phase: item.status?.phase ?? "Unknown",
        currentLoop: item.status?.currentLoop,
        maxLoops: item.spec?.maxLoops,
        confidence: item.status?.confidence,
        startTime: item.status?.startTime,
        completionTime: item.status?.completionTime,
        message: item.status?.message,
        podName: item.status?.podName,
      };
    } catch {
      return null;
    }
  }

  /** Create a K8s informer for SwarmRun CRDs */
  createInformer(
    onUpdate: (run: SwarmRunSummary) => void,
    onDelete: (name: string) => void,
  ): k8s.Informer<Record<string, any>> {
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }

    const listFn = () =>
      this.customApi.listNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: this.namespace,
        plural: CRD_PLURAL,
      });

    const informer = k8s.makeInformer(
      kc,
      `/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${this.namespace}/${CRD_PLURAL}`,
      listFn as any,
    );

    const toSummary = (item: Record<string, any>): SwarmRunSummary => ({
      name: item.metadata?.name ?? "",
      phase: item.status?.phase ?? "Unknown",
      currentLoop: item.status?.currentLoop,
      maxLoops: item.spec?.maxLoops,
      confidence: item.status?.confidence,
      startTime: item.status?.startTime,
      completionTime: item.status?.completionTime,
      message: item.status?.message,
      podName: item.status?.podName,
    });

    informer.on("add", (obj) => onUpdate(toSummary(obj)));
    informer.on("update", (obj) => onUpdate(toSummary(obj)));
    informer.on("delete", (obj) => onDelete(obj.metadata?.name ?? ""));

    return informer;
  }
}
