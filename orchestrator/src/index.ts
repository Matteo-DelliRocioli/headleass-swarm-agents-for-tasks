// ---------------------------------------------------------------------------
// Swarm Orchestrator — the main loop that runs inside the pod
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import * as beads from "./beads.js";
import { loadPersonas, matchPersonaToTask } from "./persona-loader.js";
import { spawnAgent, spawnReviewer, spawnPlanner, reviewPlan, revisePlan, type PlannerOutput } from "./agent-spawner.js";
import { aggregateReviews, type ReviewResult } from "./review-aggregator.js";
import { addMemory, type Mem0Config } from "./mem0.js";
import { getQueueStats, drainQueue } from "./message-queue.js";
import { UsageAccumulator } from "./usage-tracker.js";

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
  const usage = new UsageAccumulator(config.model);
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

  // Spawn the planner agent and iterate with review until approved
  const plannerPersona = personas.get("planner-agent");
  const masterReviewer = personas.get("master-reviewer");

  if (!plannerPersona) {
    logger.warn("Planner persona not found — falling back to single task");
    const taskId = await beads.createTask(config.initialPrompt.slice(0, 80), epicId, {
      priority: 1,
      description: config.initialPrompt,
    });
    totalTasks++;
    logger.info("Created single task (no planner)", { taskId });
  } else {
    // --- Plan↔Review iteration loop ---
    const planSession = await spawnPlanner(plannerPersona, config.initialPrompt, config);
    let currentPlan: PlannerOutput = planSession.plan;
    let planApproved = false;

    if (currentPlan.tasks.length > 0 && masterReviewer) {
      for (let planLoop = 1; planLoop <= config.maxPlanLoops; planLoop++) {
        logger.info(`Plan review iteration ${planLoop}/${config.maxPlanLoops}`, {
          taskCount: currentPlan.tasks.length,
          summary: currentPlan.summary,
        });

        const review = await reviewPlan(currentPlan, masterReviewer, config);

        if (review.approved || review.score >= config.planApprovalThreshold) {
          logger.info("Plan approved", { score: review.score, iteration: planLoop });
          planApproved = true;
          break;
        }

        if (planLoop >= config.maxPlanLoops) {
          logger.warn("Plan review max loops reached — accepting best effort", {
            score: review.score,
            loops: planLoop,
          });
          break;
        }

        // Send feedback to planner for revision (same session — retains context)
        logger.info("Plan rejected, requesting revision", {
          score: review.score,
          issueCount: review.issues.length,
          feedback: review.feedback.slice(0, 200),
        });

        currentPlan = await revisePlan(
          planSession.sessionId,
          review,
          planLoop,
          config,
        );

        if (currentPlan.tasks.length === 0) {
          logger.warn("Planner returned empty revision — stopping iteration");
          break;
        }
      }
    } else if (currentPlan.tasks.length > 0) {
      // No master-reviewer persona available — skip plan review
      logger.warn("Master-reviewer not found — skipping plan review, using initial plan");
      planApproved = true;
    }

    if (!planApproved && currentPlan.tasks.length > 0) {
      logger.info("Proceeding with best available plan (not explicitly approved)", {
        taskCount: currentPlan.tasks.length,
      });
    }

    // --- Materialize the final plan into beads tasks ---
    if (currentPlan.tasks.length === 0) {
      logger.warn("Plan has no tasks — creating single fallback task");
      const taskId = await beads.createTask(config.initialPrompt.slice(0, 80), epicId, {
        priority: 1,
        description: config.initialPrompt,
      });
      totalTasks++;
      logger.info("Created fallback task", { taskId });
    } else {
      // Create all tasks first, build title→ID map
      const titleToId = new Map<string, string>();
      for (const planned of currentPlan.tasks) {
        const taskId = await beads.createTask(planned.title.slice(0, 80), epicId, {
          priority: planned.priority,
          description: planned.description,
        });
        titleToId.set(planned.title, taskId);
        totalTasks++;
        logger.info("Created planned task", {
          taskId,
          title: planned.title,
          persona: planned.suggested_persona,
          priority: planned.priority,
        });
      }

      // Wire up dependencies (second pass)
      for (const planned of currentPlan.tasks) {
        if (!planned.depends_on?.length) continue;
        const childId = titleToId.get(planned.title);
        if (!childId) continue;

        for (const depTitle of planned.depends_on) {
          const parentId = titleToId.get(depTitle);
          if (parentId) {
            await beads.addDependency(childId, parentId);
            logger.info("Added dependency", { child: planned.title, parent: depTitle });
          } else {
            logger.warn("Dependency target not found", { child: planned.title, missingDep: depTitle });
          }
        }
      }

      logger.info("Plan materialized into tasks", {
        totalTasks: currentPlan.tasks.length,
        withDependencies: currentPlan.tasks.filter(t => t.depends_on?.length).length,
        planApproved,
      });
    }
  }

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
        usage.add(persona.id, result.usage);
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

    const reviewPersonas = [...personas.values()].filter(p => p.isReviewer && p.id !== "master-reviewer" && p.id !== "planner-agent");
    const reviewResults: ReviewResult[] = [];

    // Spawn all review agents in parallel — each returns structured score + issues
    const reviewPromises = reviewPersonas.map(async (persona) => {
      try {
        const output = await spawnReviewer(persona, currentLoop, config);
        usage.add(persona.id, output.usage);
        return {
          reviewerId: persona.id,
          score: output.score,
          issues: output.issues,
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

    // Store loop observation in Mem0 for next iteration's agents
    const mem0Config: Mem0Config = { apiUrl: config.mem0ApiUrl, runName: config.runName };
    const criticalSummary = aggregated.criticalIssues.length > 0
      ? ` Critical issues: ${aggregated.criticalIssues.map(i => i.description.slice(0, 60)).join("; ")}`
      : "";
    await addMemory(
      `Loop ${currentLoop} completed. Confidence: ${aggregated.confidence}. Follow-ups: ${aggregated.followUpTasks.length}.${criticalSummary}`,
      "orchestrator",
      mem0Config,
      "loop-summary",
    );

    // Log usage and cost for this run so far
    usage.logSummary();

    // Log queue stats and drain pending messages between loops
    const queueStats = await getQueueStats(config.swarmStatePath);
    if (queueStats.pendingMessages > 0) {
      logger.info("Queue stats before drain", {
        pending: queueStats.pendingMessages,
        urgent: queueStats.urgentPending,
        perAgent: queueStats.perAgent,
      });
      await drainQueue(config.swarmStatePath);
    }

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
        tokenUsage: { total: usage.getTotal(), perAgent: usage.getPerAgent() },
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
        tokenUsage: { total: usage.getTotal(), perAgent: usage.getPerAgent() },
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
        tokenUsage: { total: usage.getTotal(), perAgent: usage.getPerAgent() },
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
