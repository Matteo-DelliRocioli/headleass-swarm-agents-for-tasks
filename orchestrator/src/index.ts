// ---------------------------------------------------------------------------
// Swarm Orchestrator — the main loop that runs inside the pod
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import * as beads from "./beads.js";
import { loadPersonas, matchPersonaToTask } from "./persona-loader.js";
import { spawnAgent, spawnReviewer } from "./agent-spawner.js";
import { aggregateReviews, type ReviewResult } from "./review-aggregator.js";

// ---------------------------------------------------------------------------
// Termination signal — writes result to /dev/termination-log + result.json
// ---------------------------------------------------------------------------

interface SwarmRunResult {
  marker: "SWARM_RUN_COMPLETE";
  status: "success" | "failed" | "max_loops_reached";
  confidence: number;
  loopsExecuted: number;
  maxLoops: number;
  totalTasks: number;
  completedTasks: number;
  followUpTasks: number;
  deferredTaskIds: string[];
  tokenUsage: { total: number; perAgent: Record<string, number> };
  duration: { totalMs: number; perLoop: number[] };
  errors: string[];
}

function writeTermination(result: SwarmRunResult, swarmStatePath: string): void {
  const json = JSON.stringify(result);
  const terminationMessage = `SWARM_RUN_COMPLETE:${json}`;

  // Write to K8s termination log (4KB limit, truncate if needed)
  try {
    const truncated = terminationMessage.length > 4000
      ? terminationMessage.slice(0, 4000)
      : terminationMessage;
    writeFileSync("/dev/termination-log", truncated);
  } catch (err) {
    logger.warn("Failed to write /dev/termination-log", { error: String(err) });
  }

  // Write full result to shared volume
  const resultPath = join(swarmStatePath, "result.json");
  mkdirSync(swarmStatePath, { recursive: true });
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  logger.info("Termination signal written", { path: resultPath, status: result.status });
}

// ---------------------------------------------------------------------------
// Main orchestrator loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const startTime = Date.now();
  const errors: string[] = [];
  const loopDurations: number[] = [];
  const tokenUsage: Record<string, number> = {};
  let totalTasks = 0;
  let completedTasks = 0;

  logger.info("Swarm Orchestrator starting", {
    runName: config.runName,
    maxLoops: config.maxLoops,
    confidenceThreshold: config.confidenceThreshold,
    model: config.model,
    personas: config.personas,
  });

  // Ensure .swarm directory exists
  mkdirSync(config.swarmStatePath, { recursive: true });

  // Load personas
  const personas = await loadPersonas(config.personasPath);
  if (personas.size === 0) {
    logger.error("No personas found", { path: config.personasPath });
    writeTermination({
      marker: "SWARM_RUN_COMPLETE",
      status: "failed",
      confidence: 0,
      loopsExecuted: 0,
      maxLoops: config.maxLoops,
      totalTasks: 0,
      completedTasks: 0,
      followUpTasks: 0,
      deferredTaskIds: [],
      tokenUsage: { total: 0, perAgent: {} },
      duration: { totalMs: Date.now() - startTime, perLoop: [] },
      errors: ["No personas found"],
    }, config.swarmStatePath);
    process.exit(1);
  }

  // =====================================================================
  // PHASE 1: Task Decomposition (first loop only uses the initial prompt)
  // =====================================================================

  logger.info("Phase 1: Task decomposition");

  // Create epic for this swarm run
  const epicId = await beads.createEpic(
    `SwarmRun: ${config.initialPrompt.slice(0, 60)}`,
    config.initialPrompt,
  );
  logger.info("Created epic", { epicId });

  // Use the plan-mode agent to decompose the prompt into subtasks
  // For now, we create a single task from the prompt. A more sophisticated
  // version would use an OpenCode Plan agent to generate subtasks.
  const taskId = await beads.createTask(config.initialPrompt.slice(0, 80), epicId, {
    priority: 1,
    description: config.initialPrompt,
  });
  totalTasks++;
  logger.info("Created initial task", { taskId });

  // =====================================================================
  // MAIN LOOP
  // =====================================================================

  let currentLoop = 0;
  let lastConfidence = 0;

  while (currentLoop < config.maxLoops) {
    currentLoop++;
    const loopStart = Date.now();
    logger.info(`=== LOOP ${currentLoop}/${config.maxLoops} ===`);

    // -------------------------------------------------------------------
    // PHASE 2: Implementation
    // -------------------------------------------------------------------
    logger.info("Phase 2: Implementation");

    const readyTasks = await beads.getReadyTasks();
    logger.info("Ready tasks", { count: readyTasks.length, tasks: readyTasks.map(t => t.id) });

    for (const task of readyTasks) {
      const persona = matchPersonaToTask(
        task.title,
        task.description,
        personas,
        config.personas.length > 0 ? config.personas : undefined,
      );

      if (!persona) {
        logger.warn("No persona matched for task, skipping", { taskId: task.id });
        continue;
      }

      try {
        const claimed = await beads.claimTask(task.id);
        if (!claimed) {
          logger.warn("Failed to claim task", { taskId: task.id });
          continue;
        }

        const result = await spawnAgent(persona, task, config);
        tokenUsage[persona.id] = (tokenUsage[persona.id] ?? 0) + 1; // Placeholder — real token tracking TBD
        completedTasks++;

        logger.info("Agent completed", {
          sessionId: result.sessionId,
          persona: persona.id,
          task: task.id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Agent ${persona.id} failed on ${task.id}: ${msg}`);
        logger.error("Agent failed", { persona: persona.id, task: task.id, error: msg });
      }
    }

    // -------------------------------------------------------------------
    // PHASE 3: Parallel Review
    // -------------------------------------------------------------------
    logger.info("Phase 3: Parallel review");

    const reviewPersonas = [...personas.values()].filter(p => p.isReviewer && p.id !== "master-reviewer");
    const reviewResults: ReviewResult[] = [];

    // Spawn all review agents in parallel
    const reviewPromises = reviewPersonas.map(async (persona) => {
      try {
        const result = await spawnReviewer(persona, currentLoop, config);
        // TODO: Read structured output from the review session
        // For now, return a placeholder
        return {
          reviewerId: persona.id,
          score: 0.85, // Placeholder — real score from session output
          issues: [],
        } as ReviewResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Reviewer ${persona.id} failed: ${msg}`);
        logger.error("Reviewer failed", { persona: persona.id, error: msg });
        return null;
      }
    });

    const settled = await Promise.allSettled(reviewPromises);
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) {
        reviewResults.push(result.value);
      }
    }

    // -------------------------------------------------------------------
    // PHASE 4: Confidence Scoring
    // -------------------------------------------------------------------
    logger.info("Phase 4: Confidence scoring");

    const aggregated = aggregateReviews(reviewResults);
    lastConfidence = aggregated.confidence;

    const loopDuration = Date.now() - loopStart;
    loopDurations.push(loopDuration);

    logger.info("Loop complete", {
      loop: currentLoop,
      confidence: aggregated.confidence,
      threshold: config.confidenceThreshold,
      followUpTasks: aggregated.followUpTasks.length,
      durationMs: loopDuration,
    });

    // Check termination conditions
    if (aggregated.confidence >= config.confidenceThreshold) {
      logger.info("Confidence threshold met, stopping");
      writeTermination({
        marker: "SWARM_RUN_COMPLETE",
        status: "success",
        confidence: aggregated.confidence,
        loopsExecuted: currentLoop,
        maxLoops: config.maxLoops,
        totalTasks,
        completedTasks,
        followUpTasks: 0,
        deferredTaskIds: [],
        tokenUsage: { total: Object.values(tokenUsage).reduce((a, b) => a + b, 0), perAgent: tokenUsage },
        duration: { totalMs: Date.now() - startTime, perLoop: loopDurations },
        errors,
      }, config.swarmStatePath);
      process.exit(0);
    }

    if (aggregated.followUpTasks.length === 0) {
      logger.info("No follow-up tasks, stopping");
      writeTermination({
        marker: "SWARM_RUN_COMPLETE",
        status: "success",
        confidence: aggregated.confidence,
        loopsExecuted: currentLoop,
        maxLoops: config.maxLoops,
        totalTasks,
        completedTasks,
        followUpTasks: 0,
        deferredTaskIds: [],
        tokenUsage: { total: Object.values(tokenUsage).reduce((a, b) => a + b, 0), perAgent: tokenUsage },
        duration: { totalMs: Date.now() - startTime, perLoop: loopDurations },
        errors,
      }, config.swarmStatePath);
      process.exit(0);
    }

    // Check if max loops reached
    if (currentLoop >= config.maxLoops) {
      logger.info("MAX LOOPS REACHED. HARD STOP.");
      const deferredIds: string[] = [];
      for (const followUp of aggregated.followUpTasks) {
        const id = await beads.createTask(followUp.title, epicId, {
          priority: followUp.priority,
          description: followUp.description,
        });
        deferredIds.push(id);
        totalTasks++;
      }

      writeTermination({
        marker: "SWARM_RUN_COMPLETE",
        status: "max_loops_reached",
        confidence: aggregated.confidence,
        loopsExecuted: currentLoop,
        maxLoops: config.maxLoops,
        totalTasks,
        completedTasks,
        followUpTasks: deferredIds.length,
        deferredTaskIds: deferredIds,
        tokenUsage: { total: Object.values(tokenUsage).reduce((a, b) => a + b, 0), perAgent: tokenUsage },
        duration: { totalMs: Date.now() - startTime, perLoop: loopDurations },
        errors,
      }, config.swarmStatePath);
      process.exit(2); // Exit code 2 = max loops reached
    }

    // -------------------------------------------------------------------
    // PHASE 5: Create follow-up tasks and loop
    // -------------------------------------------------------------------
    logger.info("Creating follow-up tasks for next loop");

    for (const followUp of aggregated.followUpTasks) {
      const id = await beads.createTask(followUp.title, epicId, {
        priority: followUp.priority,
        description: followUp.description,
      });
      totalTasks++;
      logger.info("Created follow-up task", { id, title: followUp.title });
    }
  }

  // Should not reach here (loops terminate via exit above), but just in case
  logger.error("Unexpected exit from main loop");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) });

  // Attempt to write a failure termination signal
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
