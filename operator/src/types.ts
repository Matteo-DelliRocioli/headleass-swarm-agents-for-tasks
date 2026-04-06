import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const ResourceRequirementsSchema = z.object({
  memory: z.string().optional(),
  cpu: z.string().optional(),
});

export const SwarmRunResourcesSchema = z.object({
  opencode: ResourceRequirementsSchema.optional(),
  orchestrator: ResourceRequirementsSchema.optional(),
  beads: ResourceRequirementsSchema.optional(),
  playwright: ResourceRequirementsSchema.optional(),
});

export const SwarmRunSpecSchema = z.object({
  prompt: z.string().min(1),
  maxLoops: z.number().int().positive().default(3),
  confidenceThreshold: z.number().min(0).max(1).default(0.85),
  personas: z.array(z.string()).optional(),
  model: z.string().default("anthropic/claude-sonnet-4-20250514"),
  resources: SwarmRunResourcesSchema.optional(),
  gitRepo: z.string().optional(),
  gitBranch: z.string().default("main"),
  timeout: z.string().default("2h"),
  priority: z.number().int().min(0).max(4).default(2),
  maxRestarts: z.number().int().min(0).default(2).optional(),
});

export const K8sConditionSchema = z.object({
  type: z.string(),
  status: z.enum(["True", "False", "Unknown"]),
  lastTransitionTime: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
});

export const SwarmRunResultsSchema = z.object({
  marker: z.literal("SWARM_RUN_COMPLETE"),
  status: z.enum(["success", "failed", "max_loops_reached"]),
  confidence: z.number(),
  loopsExecuted: z.number().int(),
  maxLoops: z.number().int(),
  totalTasks: z.number().int(),
  completedTasks: z.number().int(),
  followUpTasks: z.number().int(),
  deferredTaskIds: z.array(z.string()),
  tokenUsage: z.object({
    total: z.number(),
    perAgent: z.record(z.string(), z.number()),
  }),
  duration: z.object({
    totalMs: z.number(),
    perLoop: z.array(z.number()),
  }),
  errors: z.array(z.string()),
});

export const SwarmRunPhaseSchema = z.enum([
  "Queued",
  "Running",
  "Reviewing",
  "Completed",
  "Failed",
  "TimedOut",
]);

export const SwarmRunStatusSchema = z.object({
  phase: SwarmRunPhaseSchema,
  beadsIssueId: z.string().optional(),
  podName: z.string().optional(),
  currentLoop: z.number().int().optional(),
  confidence: z.number().optional(),
  startTime: z.string().optional(),
  completionTime: z.string().optional(),
  message: z.string().optional(),
  restartCount: z.number().int().default(0).optional(),
  conditions: z.array(K8sConditionSchema).optional(),
  results: SwarmRunResultsSchema.optional(),
});

export const SwarmRunSchema = z.object({
  apiVersion: z.string(),
  kind: z.literal("SwarmRun"),
  metadata: z.object({
    name: z.string(),
    namespace: z.string().optional(),
    uid: z.string().optional(),
    resourceVersion: z.string().optional(),
    creationTimestamp: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }),
  spec: SwarmRunSpecSchema,
  status: SwarmRunStatusSchema.optional(),
});

// ---------------------------------------------------------------------------
// TypeScript interfaces (inferred from Zod schemas)
// ---------------------------------------------------------------------------

export type ResourceRequirements = z.infer<typeof ResourceRequirementsSchema>;
export type SwarmRunResources = z.infer<typeof SwarmRunResourcesSchema>;
export type SwarmRunSpec = z.infer<typeof SwarmRunSpecSchema>;
export type K8sCondition = z.infer<typeof K8sConditionSchema>;
export type SwarmRunResults = z.infer<typeof SwarmRunResultsSchema>;
export type SwarmRunPhase = z.infer<typeof SwarmRunPhaseSchema>;
export type SwarmRunStatus = z.infer<typeof SwarmRunStatusSchema>;
export type SwarmRun = z.infer<typeof SwarmRunSchema>;
