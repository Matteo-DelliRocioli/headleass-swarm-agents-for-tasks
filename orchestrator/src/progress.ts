// ---------------------------------------------------------------------------
// Progress reporter — patches pod annotations so the operator and dashboard
// can track loop progress and confidence without parsing logs.
// ---------------------------------------------------------------------------

import { logger } from "./logger.js";

const ANNOTATION_PREFIX = "swarm.agentswarm.io";
const NAMESPACE = process.env.NAMESPACE ?? process.env.POD_NAMESPACE ?? "default";
const POD_NAME = process.env.HOSTNAME ?? "";
const K8S_API = process.env.KUBERNETES_SERVICE_HOST
  ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
  : "";
const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

let _token: string | null = null;

async function getToken(): Promise<string> {
  if (_token) return _token;
  try {
    const { readFile } = await import("node:fs/promises");
    _token = (await readFile(SA_TOKEN_PATH, "utf-8")).trim();
    return _token;
  } catch {
    return "";
  }
}

/**
 * Report progress by patching the pod's annotations.
 * The operator reads these annotations to update the SwarmRun CRD status.
 *
 * This is a best-effort operation — if it fails (e.g., running outside K8s),
 * the orchestrator continues normally.
 */
export async function reportProgress(data: {
  currentLoop?: number;
  maxLoops?: number;
  confidence?: number;
  phase?: string;
  activeAgents?: number;
  completedTasks?: number;
  totalTasks?: number;
  estimatedCostUsd?: number;
}): Promise<void> {
  if (!K8S_API || !POD_NAME) {
    logger.debug("reportProgress: not in K8s pod, skipping");
    return;
  }

  const annotations: Record<string, string> = {};
  if (data.currentLoop !== undefined) annotations[`${ANNOTATION_PREFIX}/current-loop`] = String(data.currentLoop);
  if (data.maxLoops !== undefined) annotations[`${ANNOTATION_PREFIX}/max-loops`] = String(data.maxLoops);
  if (data.confidence !== undefined) annotations[`${ANNOTATION_PREFIX}/confidence`] = String(data.confidence);
  if (data.phase !== undefined) annotations[`${ANNOTATION_PREFIX}/phase`] = data.phase;
  if (data.activeAgents !== undefined) annotations[`${ANNOTATION_PREFIX}/active-agents`] = String(data.activeAgents);
  if (data.completedTasks !== undefined) annotations[`${ANNOTATION_PREFIX}/completed-tasks`] = String(data.completedTasks);
  if (data.totalTasks !== undefined) annotations[`${ANNOTATION_PREFIX}/total-tasks`] = String(data.totalTasks);
  if (data.estimatedCostUsd !== undefined) annotations[`${ANNOTATION_PREFIX}/estimated-cost-usd`] = String(data.estimatedCostUsd);

  if (Object.keys(annotations).length === 0) return;

  try {
    const token = await getToken();
    const url = `${K8S_API}/api/v1/namespaces/${NAMESPACE}/pods/${POD_NAME}`;

    const patch = {
      metadata: { annotations },
    };

    const resp = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/merge-patch+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(patch),
      // @ts-expect-error Node 20 fetch supports this
      dispatcher: K8S_API.startsWith("https") ? undefined : undefined,
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.warn("reportProgress: patch failed", { status: resp.status, body: body.slice(0, 200) });
    } else {
      logger.debug("reportProgress: annotations patched", { annotations });
    }
  } catch (err) {
    logger.warn("reportProgress: error", { error: String(err) });
  }
}
