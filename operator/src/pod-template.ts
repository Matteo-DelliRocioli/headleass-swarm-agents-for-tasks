// ---------------------------------------------------------------------------
// Pod template builder — creates sidecar pod spec for a SwarmRun
// ---------------------------------------------------------------------------

import * as k8s from "@kubernetes/client-node";
import type { SwarmRun } from "./types.js";
import type { Config } from "./config.js";

const CRD_GROUP = "swarm.agentswarm.io";
const CRD_VERSION = "v1alpha1";

export function buildSwarmPod(swarmRun: SwarmRun, config: Config): k8s.V1Pod {
  const name = swarmRun.metadata.name;
  const namespace = swarmRun.metadata.namespace ?? config.namespace;
  const spec = swarmRun.spec;
  const res = spec.resources;

  // Helper to build resource requirements for a container
  const resources = (
    container: "opencode" | "orchestrator" | "beads" | "playwright",
  ): k8s.V1ResourceRequirements => {
    const custom = res?.[container];
    const defaults = config.defaultResources[container];
    return {
      requests: {
        memory: custom?.memory ?? defaults.memory,
        cpu: custom?.cpu ?? defaults.cpu,
      },
      limits: {
        memory: custom?.memory ?? defaults.memory,
        cpu: custom?.cpu ?? defaults.cpu,
      },
    };
  };

  const pod: k8s.V1Pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `swarm-run-${name}`,
      namespace,
      labels: {
        app: "agent-swarm",
        [`${CRD_GROUP}/run`]: name,
      },
      ownerReferences: [
        {
          apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
          kind: "SwarmRun",
          name,
          uid: swarmRun.metadata.uid ?? "",
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      restartPolicy: "Never",
      serviceAccountName: "swarm-runner",
      volumes: [
        {
          name: "workspace",
          persistentVolumeClaim: { claimName: "swarm-workspaces" },
        },
      ],
      containers: [
        // 1. opencode
        {
          name: "opencode",
          image: config.images.opencode,
          command: ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"],
          readinessProbe: {
            httpGet: {
              port: 4096,
              path: "/health",
            },
            initialDelaySeconds: 5,
            periodSeconds: 10,
          },
          resources: resources("opencode"),
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace", subPath: name },
          ],
        },
        // 2. beads
        {
          name: "beads",
          image: config.images.beads,
          command: ["bd", "daemon", "start", "--local"],
          readinessProbe: {
            tcpSocket: {
              port: 3307,
            },
            initialDelaySeconds: 5,
            periodSeconds: 10,
          },
          resources: resources("beads"),
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace", subPath: name },
          ],
        },
        // 3. orchestrator
        {
          name: "orchestrator",
          image: config.images.orchestrator,
          command: ["/bin/bash", "/app/entrypoint.sh"],
          env: [
            { name: "SWARM_RUN_NAME", value: name },
            { name: "SWARM_INITIAL_PROMPT", value: spec.prompt },
            { name: "SWARM_MAX_LOOPS", value: String(spec.maxLoops) },
            { name: "SWARM_CONFIDENCE_THRESHOLD", value: String(spec.confidenceThreshold) },
            { name: "SWARM_MODEL", value: spec.model },
            { name: "SWARM_PERSONAS", value: (spec.personas ?? []).join(",") },
            { name: "MEM0_API_URL", value: process.env.MEM0_API_URL ?? "http://mem0:8080" },
            {
              name: "ANTHROPIC_API_KEY",
              valueFrom: {
                secretKeyRef: {
                  name: "anthropic-api-key",
                  key: "api-key",
                },
              },
            },
          ],
          resources: resources("orchestrator"),
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace", subPath: name },
          ],
          terminationMessagePath: "/dev/termination-log",
          terminationMessagePolicy: "File",
        },
        // 4. playwright
        {
          name: "playwright",
          image: config.images.playwright,
          command: ["sleep", "infinity"],
          resources: resources("playwright"),
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace", subPath: name },
          ],
        },
      ],
    },
  };

  return pod;
}
