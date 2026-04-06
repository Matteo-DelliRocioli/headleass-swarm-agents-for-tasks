// ---------------------------------------------------------------------------
// Dashboard server — Hono + SSE aggregation + terminal proxy
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import * as k8s from "@kubernetes/client-node";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const NAMESPACE = process.env.NAMESPACE ?? "default";

const CRD_GROUP = "swarm.agentswarm.io";
const CRD_VERSION = "v1alpha1";
const CRD_PLURAL = "swarmruns";

// ---------------------------------------------------------------------------
// K8s clients
// ---------------------------------------------------------------------------

const kc = new k8s.KubeConfig();
try {
  kc.loadFromCluster();
} catch {
  kc.loadFromDefault();
}
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

// ---------------------------------------------------------------------------
// In-memory state (updated by informer)
// ---------------------------------------------------------------------------

interface RunState {
  name: string;
  phase: string;
  currentLoop?: number;
  maxLoops?: number;
  confidence?: number;
  startTime?: string;
  completionTime?: string;
  message?: string;
  podName?: string;
  podIp?: string;
}

const runs = new Map<string, RunState>();
const sseClients = new Set<(event: string, data: string) => void>();

function broadcastSSE(event: string, data: unknown): void {
  const json = JSON.stringify(data);
  for (const send of sseClients) {
    try {
      send(event, json);
    } catch {
      // Client disconnected
    }
  }
}

// ---------------------------------------------------------------------------
// K8s informer
// ---------------------------------------------------------------------------

async function startInformer(): Promise<void> {
  const listFn = () =>
    customApi.listNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: NAMESPACE,
      plural: CRD_PLURAL,
    });

  const informer = k8s.makeInformer(
    kc,
    `/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${NAMESPACE}/${CRD_PLURAL}`,
    listFn as any,
  );

  const handleUpdate = async (obj: Record<string, any>) => {
    const name = obj.metadata?.name ?? "";
    const state: RunState = {
      name,
      phase: obj.status?.phase ?? "Unknown",
      currentLoop: obj.status?.currentLoop,
      maxLoops: obj.spec?.maxLoops,
      confidence: obj.status?.confidence,
      startTime: obj.status?.startTime,
      completionTime: obj.status?.completionTime,
      message: obj.status?.message,
      podName: obj.status?.podName,
    };

    // Resolve pod IP if we have a pod name
    if (state.podName && !state.podIp) {
      try {
        const pod = await coreApi.readNamespacedPod({
          name: state.podName,
          namespace: NAMESPACE,
        });
        state.podIp = pod.status?.podIP;
      } catch {
        // Pod may not exist yet
      }
    }

    runs.set(name, state);
    broadcastSSE("run:update", state);
  };

  informer.on("add", handleUpdate);
  informer.on("update", handleUpdate);
  informer.on("delete", (obj) => {
    const name = obj.metadata?.name ?? "";
    runs.delete(name);
    broadcastSSE("run:delete", { name });
  });

  await informer.start();
  console.log("K8s informer started");
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

// Static files (dashboard UI)
app.use("/", serveStatic({ root: "./public", path: "index.html" }));
app.use("/static/*", serveStatic({ root: "./public" }));

// REST: list all runs
app.get("/api/runs", (c) => {
  return c.json([...runs.values()]);
});

// REST: get single run
app.get("/api/runs/:name", (c) => {
  const run = runs.get(c.req.param("name"));
  if (!run) return c.json({ error: "Not found" }, 404);
  return c.json(run);
});

// REST: delete a run
app.delete("/api/runs/:name", async (c) => {
  const name = c.req.param("name");
  try {
    await customApi.deleteNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: NAMESPACE,
      plural: CRD_PLURAL,
      name,
    });
    return c.json({ deleted: name });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// SSE: aggregated event stream
app.get("/api/stream", (c) => {
  return streamSSE(c, async (stream) => {
    const send = (event: string, data: string) => {
      stream.writeSSE({ event, data }).catch(() => {});
    };

    sseClients.add(send);

    // Send current state as initial payload
    for (const run of runs.values()) {
      await stream.writeSSE({ event: "run:update", data: JSON.stringify(run) });
    }

    // Keep alive
    const keepAlive = setInterval(() => {
      stream.writeSSE({ event: "ping", data: "" }).catch(() => {
        clearInterval(keepAlive);
      });
    }, 15000);

    // Wait for disconnect
    try {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      sseClients.delete(send);
      clearInterval(keepAlive);
    }
  });
});

// Reverse proxy: terminal access to pod's OpenCode web UI
app.all("/terminal/:podName/*", async (c) => {
  const podName = c.req.param("podName");
  const run = [...runs.values()].find((r) => r.podName === podName);
  const podIp = run?.podIp;

  if (!podIp) {
    return c.json({ error: `Pod ${podName} not found or no IP` }, 404);
  }

  // Proxy to OpenCode web UI on the pod
  const path = c.req.path.replace(`/terminal/${podName}`, "") || "/";
  const targetUrl = `http://${podIp}:4096${path}`;

  try {
    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");

    const resp = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
    });

    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  } catch (err) {
    return c.json({ error: `Proxy failed: ${err}` }, 502);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await startInformer();
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`Dashboard running at http://localhost:${info.port}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
