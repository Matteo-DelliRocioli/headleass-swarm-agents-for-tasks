import { z } from "zod";

const ConfigSchema = z.object({
  namespace: z.string().min(1),
  maxConcurrentRuns: z.number().int().positive(),
  cleanupRetentionMinutes: z.number().int().nonnegative(),
  staleCheckIntervalMinutes: z.number().int().positive(),
  periodicSyncSeconds: z.number().int().positive(),

  images: z.object({
    opencode: z.string().min(1),
    orchestrator: z.string().min(1),
    beads: z.string().min(1),
    playwright: z.string().min(1),
  }),

  defaultResources: z.object({
    opencode: z.object({ memory: z.string(), cpu: z.string() }),
    orchestrator: z.object({ memory: z.string(), cpu: z.string() }),
    beads: z.object({ memory: z.string(), cpu: z.string() }),
    playwright: z.object({ memory: z.string(), cpu: z.string() }),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

function readConfig(): Config {
  const raw = {
    namespace: process.env.NAMESPACE ?? "default",
    maxConcurrentRuns: Number(process.env.MAX_CONCURRENT_RUNS ?? "5"),
    cleanupRetentionMinutes: Number(process.env.CLEANUP_RETENTION_MINUTES ?? "60"),
    staleCheckIntervalMinutes: Number(process.env.STALE_CHECK_INTERVAL_MINUTES ?? "5"),
    periodicSyncSeconds: Number(process.env.PERIODIC_SYNC_SECONDS ?? "60"),

    images: {
      opencode: process.env.SWARM_IMAGE_OPENCODE ?? "swarm-opencode:latest",
      orchestrator: process.env.SWARM_IMAGE_ORCHESTRATOR ?? "swarm-orchestrator:latest",
      beads: process.env.SWARM_IMAGE_BEADS ?? "swarm-beads:latest",
      playwright: process.env.SWARM_IMAGE_PLAYWRIGHT ?? "mcr.microsoft.com/playwright:v1.50.0-noble",
    },

    defaultResources: {
      opencode: {
        memory: process.env.DEFAULT_OPENCODE_MEMORY ?? "4Gi",
        cpu: process.env.DEFAULT_OPENCODE_CPU ?? "2",
      },
      orchestrator: {
        memory: process.env.DEFAULT_ORCHESTRATOR_MEMORY ?? "2Gi",
        cpu: process.env.DEFAULT_ORCHESTRATOR_CPU ?? "1",
      },
      beads: {
        memory: process.env.DEFAULT_BEADS_MEMORY ?? "1Gi",
        cpu: process.env.DEFAULT_BEADS_CPU ?? "0.5",
      },
      playwright: {
        memory: process.env.DEFAULT_PLAYWRIGHT_MEMORY ?? "2Gi",
        cpu: process.env.DEFAULT_PLAYWRIGHT_CPU ?? "1",
      },
    },
  };

  return ConfigSchema.parse(raw);
}

export const config: Config = readConfig();
