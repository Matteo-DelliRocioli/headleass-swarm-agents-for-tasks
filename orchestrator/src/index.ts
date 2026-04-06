// ---------------------------------------------------------------------------
// Swarm Orchestrator — thin entry point that wires deps and handles exit
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import * as beads from "./beads.js";
import { loadPersonas, matchPersonaToTask } from "./persona-loader.js";
import { spawnAgent, spawnReviewer, spawnPlanner, reviewPlan, revisePlan } from "./agent-spawner.js";
import { aggregateReviews } from "./review-aggregator.js";
import { addMemory } from "./mem0.js";
import { getQueueStats, drainQueue } from "./message-queue.js";
import { reportProgress } from "./progress.js";
import { runRegressionGate } from "./regression-gate.js";
import { runOrchestrator, type SwarmRunResult } from "./orchestrator.js";

// ---------------------------------------------------------------------------
// Termination signal — writes result to /dev/termination-log + result.json
// ---------------------------------------------------------------------------

function writeTermination(result: SwarmRunResult, swarmStatePath: string): void {
  const json = JSON.stringify(result);
  const terminationMessage = `SWARM_RUN_COMPLETE:${json}`;

  try {
    const truncated = terminationMessage.length > 4000
      ? terminationMessage.slice(0, 4000)
      : terminationMessage;
    writeFileSync("/dev/termination-log", truncated);
  } catch (err) {
    logger.warn("Failed to write /dev/termination-log", { error: String(err) });
  }

  const resultPath = join(swarmStatePath, "result.json");
  mkdirSync(swarmStatePath, { recursive: true });
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  logger.info("Termination signal written", { path: resultPath, status: result.status });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();

  const result = await runOrchestrator(config, {
    beads: {
      createEpic: beads.createEpic,
      createTask: beads.createTask,
      addDependency: beads.addDependency,
      getReadyTasks: beads.getReadyTasks,
      claimTask: beads.claimTask,
      listInProgress: beads.listInProgress,
      unclaimTask: beads.unclaimTask,
      closeTask: beads.closeTask,
    },
    agents: {
      loadPersonas,
      matchPersonaToTask,
      spawnPlanner,
      reviewPlan,
      revisePlan,
      spawnAgent,
      spawnReviewer,
      aggregateReviews,
    },
    infra: {
      addMemory,
      getQueueStats,
      drainQueue,
      reportProgress,
      runRegressionGate,
    },
  });

  writeTermination(result, config.swarmStatePath);

  const exitCode = result.status === "success" ? 0
    : result.status === "max_loops_reached" ? 2
    : 1;
  process.exit(exitCode);
}

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) });

  try {
    writeTermination({
      marker: "SWARM_RUN_COMPLETE",
      status: "failed",
      confidence: 0,
      loopsExecuted: 0,
      maxLoops: parseInt(process.env.SWARM_MAX_LOOPS ?? "3", 10),
      totalTasks: 0,
      completedTasks: 0,
      followUpTasks: 0,
      deferredTaskIds: [],
      tokenUsage: { total: 0, perAgent: {} },
      duration: { totalMs: 0, perLoop: [] },
      errors: [String(err)],
    }, process.env.SWARM_STATE_PATH ?? "/workspace/.swarm");
  } catch {
    // Best effort
  }

  process.exit(1);
});
