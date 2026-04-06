// ---------------------------------------------------------------------------
// Orchestrator core — the testable loop logic, extracted from index.ts
// ---------------------------------------------------------------------------

import { mkdirSync } from "node:fs";
import { logger } from "./logger.js";
import type { OrchestratorConfig } from "./config.js";
import type { Persona } from "./persona-loader.js";
import type { PlannerOutput, PlannerSession, PlanReviewResult, SpawnResult } from "./agent-spawner.js";
import type { ReviewResult, AggregatedReview } from "./review-aggregator.js";
import type { Mem0Config } from "./mem0.js";
import type { UsageData } from "./usage-tracker.js";
import { UsageAccumulator } from "./usage-tracker.js";

// ---------------------------------------------------------------------------
// Dependency injection interface — all external calls are injectable
// ---------------------------------------------------------------------------

export interface BeadsDeps {
  createEpic: (title: string, description: string) => Promise<string>;
  createTask: (title: string, epicId: string, opts: { priority: number; description: string }) => Promise<string>;
  addDependency: (childId: string, parentId: string) => Promise<void>;
  getReadyTasks: () => Promise<Array<{ id: string; title: string; status: string; priority: number; description?: string; assignee?: string }>>;
  claimTask: (taskId: string) => Promise<boolean>;
}

export interface AgentDeps {
  loadPersonas: (path: string) => Promise<Map<string, Persona>>;
  matchPersonaToTask: (
    title: string,
    desc: string | undefined,
    personas: Map<string, Persona>,
    allowed?: string[],
    suggested?: string,
  ) => Persona | undefined;
  spawnPlanner: (persona: Persona, prompt: string, config: OrchestratorConfig) => Promise<PlannerSession>;
  reviewPlan: (plan: PlannerOutput, reviewer: Persona, config: OrchestratorConfig) => Promise<PlanReviewResult>;
  revisePlan: (sessionId: string, review: PlanReviewResult, iteration: number, config: OrchestratorConfig) => Promise<PlannerOutput>;
  spawnAgent: (persona: Persona, task: { id: string; title: string; status: string; priority: number; description?: string; assignee?: string }, config: OrchestratorConfig) => Promise<SpawnResult>;
  spawnReviewer: (persona: Persona, loop: number, config: OrchestratorConfig) => Promise<{ score: number; issues: Array<{ severity: string; description: string; file?: string; line?: number }>; usage: UsageData }>;
  aggregateReviews: (reviews: ReviewResult[]) => AggregatedReview;
}

export interface InfraDeps {
  addMemory: (text: string, agentId: string, config: Mem0Config, category?: string) => Promise<unknown>;
  getQueueStats: (path: string) => Promise<{ pendingMessages: number; urgentPending: number; perAgent: Record<string, unknown> }>;
  drainQueue: (path: string) => Promise<number>;
  reportProgress: (data: Record<string, unknown>) => Promise<void>;
}

export interface OrchestratorDeps {
  beads: BeadsDeps;
  agents: AgentDeps;
  infra: InfraDeps;
}

// ---------------------------------------------------------------------------
// Result type — returned instead of calling process.exit()
// ---------------------------------------------------------------------------

export interface SwarmRunResult {
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

// ---------------------------------------------------------------------------
// Main orchestrator loop
// ---------------------------------------------------------------------------

export async function runOrchestrator(
  config: OrchestratorConfig,
  deps: OrchestratorDeps,
): Promise<SwarmRunResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  const loopDurations: number[] = [];
  const usage = new UsageAccumulator(config.model);
  let totalTasks = 0;
  let completedTasks = 0;

  const makeResult = (
    status: SwarmRunResult["status"],
    confidence: number,
    loopsExecuted: number,
    followUpTasks: number,
    deferredTaskIds: string[] = [],
  ): SwarmRunResult => ({
    marker: "SWARM_RUN_COMPLETE",
    status,
    confidence,
    loopsExecuted,
    maxLoops: config.maxLoops,
    totalTasks,
    completedTasks,
    followUpTasks,
    deferredTaskIds,
    tokenUsage: { total: usage.getTotal(), perAgent: usage.getPerAgent() },
    duration: { totalMs: Date.now() - startTime, perLoop: loopDurations },
    errors,
  });

  logger.info("Swarm Orchestrator starting", {
    runName: config.runName,
    maxLoops: config.maxLoops,
    confidenceThreshold: config.confidenceThreshold,
    model: config.model,
    personas: config.personas,
  });

  mkdirSync(config.swarmStatePath, { recursive: true });

  // Load personas
  const personas = await deps.agents.loadPersonas(config.personasPath);
  if (personas.size === 0) {
    logger.error("No personas found", { path: config.personasPath });
    errors.push("No personas found");
    return makeResult("failed", 0, 0, 0);
  }

  // =====================================================================
  // PHASE 1: Task Decomposition
  // =====================================================================

  logger.info("Phase 1: Task decomposition");

  const epicId = await deps.beads.createEpic(
    `SwarmRun: ${config.initialPrompt.slice(0, 60)}`,
    config.initialPrompt,
  );

  const plannerPersona = personas.get("planner-agent");
  const masterReviewer = personas.get("master-reviewer");
  const taskPersonaMap = new Map<string, string>();

  if (!plannerPersona) {
    logger.warn("Planner persona not found — falling back to single task");
    const taskId = await deps.beads.createTask(config.initialPrompt.slice(0, 80), epicId, {
      priority: 1,
      description: config.initialPrompt,
    });
    totalTasks++;
  } else {
    const planSession = await deps.agents.spawnPlanner(plannerPersona, config.initialPrompt, config);
    let currentPlan: PlannerOutput = planSession.plan;
    let planApproved = false;

    if (currentPlan.tasks.length > 0 && masterReviewer) {
      for (let planLoop = 1; planLoop <= config.maxPlanLoops; planLoop++) {
        const review = await deps.agents.reviewPlan(currentPlan, masterReviewer, config);

        if (review.approved || review.score >= config.planApprovalThreshold) {
          planApproved = true;
          break;
        }

        if (planLoop >= config.maxPlanLoops) break;

        currentPlan = await deps.agents.revisePlan(
          planSession.sessionId,
          review,
          planLoop,
          config,
        );

        if (currentPlan.tasks.length === 0) break;
      }
    } else if (currentPlan.tasks.length > 0) {
      planApproved = true;
    }

    // Materialize tasks
    if (currentPlan.tasks.length === 0) {
      const taskId = await deps.beads.createTask(config.initialPrompt.slice(0, 80), epicId, {
        priority: 1,
        description: config.initialPrompt,
      });
      totalTasks++;
    } else {
      const titleToId = new Map<string, string>();
      for (const planned of currentPlan.tasks) {
        const taskId = await deps.beads.createTask(planned.title.slice(0, 80), epicId, {
          priority: planned.priority,
          description: planned.description,
        });
        titleToId.set(planned.title, taskId);
        totalTasks++;
        if (planned.suggested_persona) {
          taskPersonaMap.set(taskId, planned.suggested_persona);
        }
      }

      for (const planned of currentPlan.tasks) {
        if (!planned.depends_on?.length) continue;
        const childId = titleToId.get(planned.title);
        if (!childId) continue;
        for (const depTitle of planned.depends_on) {
          const parentId = titleToId.get(depTitle);
          if (parentId) {
            await deps.beads.addDependency(childId, parentId);
          }
        }
      }
    }
  }

  // =====================================================================
  // MAIN LOOP
  // =====================================================================

  let currentLoop = 0;

  while (currentLoop < config.maxLoops) {
    currentLoop++;
    const loopStart = Date.now();
    logger.info(`=== LOOP ${currentLoop}/${config.maxLoops} ===`);

    // PHASE 2: Implementation
    const readyTasks = await deps.beads.getReadyTasks();

    const unmatchedTasks: string[] = [];
    const taskAssignments: Array<{ task: typeof readyTasks[0]; persona: Persona }> = [];

    for (const task of readyTasks) {
      const suggestedPersona = taskPersonaMap.get(task.id);
      const persona = deps.agents.matchPersonaToTask(
        task.title,
        task.description,
        personas,
        config.personas.length > 0 ? config.personas : undefined,
        suggestedPersona,
      );

      if (!persona) {
        unmatchedTasks.push(`${task.id}: "${task.title}" (suggested: ${suggestedPersona ?? "none"})`);
        continue;
      }
      taskAssignments.push({ task, persona });
    }

    if (unmatchedTasks.length > 0) {
      const msg = `Cannot match ${unmatchedTasks.length} task(s) to any persona:\n${unmatchedTasks.join("\n")}`;
      errors.push(msg);
      return makeResult("failed", 0, currentLoop, readyTasks.length);
    }

    for (const { task, persona } of taskAssignments) {
      try {
        const claimed = await deps.beads.claimTask(task.id);
        if (!claimed) continue;
        const result = await deps.agents.spawnAgent(persona, task, config);
        usage.add(persona.id, result.usage);
        completedTasks++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Agent ${persona.id} failed on ${task.id}: ${msg}`);
      }
    }

    // PHASE 3: Parallel Review
    const reviewPersonas = [...personas.values()].filter(
      p => p.isReviewer && p.id !== "master-reviewer" && p.id !== "planner-agent",
    );
    const reviewResults: ReviewResult[] = [];

    const reviewPromises = reviewPersonas.map(async (persona) => {
      try {
        const output = await deps.agents.spawnReviewer(persona, currentLoop, config);
        usage.add(persona.id, output.usage);
        return {
          reviewerId: persona.id,
          score: output.score,
          issues: output.issues,
        } as ReviewResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Reviewer ${persona.id} failed: ${msg}`);
        return null;
      }
    });

    const settled = await Promise.allSettled(reviewPromises);
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) {
        reviewResults.push(result.value);
      }
    }

    // PHASE 4: Confidence Scoring
    const aggregated = deps.agents.aggregateReviews(reviewResults);
    const loopDuration = Date.now() - loopStart;
    loopDurations.push(loopDuration);

    await deps.infra.reportProgress({
      currentLoop,
      maxLoops: config.maxLoops,
      confidence: aggregated.confidence,
      phase: "reviewing",
      completedTasks,
      totalTasks,
      estimatedCostUsd: usage.getEstimatedCostUsd(),
    });

    const mem0Config: Mem0Config = { apiUrl: config.mem0ApiUrl, runName: config.runName };
    await deps.infra.addMemory(
      `Loop ${currentLoop} completed. Confidence: ${aggregated.confidence}. Follow-ups: ${aggregated.followUpTasks.length}.`,
      "orchestrator",
      mem0Config,
      "loop-summary",
    );

    usage.logSummary();

    const queueStats = await deps.infra.getQueueStats(config.swarmStatePath);
    if (queueStats.pendingMessages > 0) {
      await deps.infra.drainQueue(config.swarmStatePath);
    }

    // Check termination
    if (aggregated.confidence >= config.confidenceThreshold) {
      return makeResult("success", aggregated.confidence, currentLoop, 0);
    }

    if (aggregated.followUpTasks.length === 0) {
      return makeResult("success", aggregated.confidence, currentLoop, 0);
    }

    if (currentLoop >= config.maxLoops) {
      const deferredIds: string[] = [];
      for (const followUp of aggregated.followUpTasks) {
        const id = await deps.beads.createTask(followUp.title, epicId, {
          priority: followUp.priority,
          description: followUp.description,
        });
        deferredIds.push(id);
        totalTasks++;
      }
      return makeResult("max_loops_reached", aggregated.confidence, currentLoop, deferredIds.length, deferredIds);
    }

    // PHASE 5: Create follow-up tasks
    for (const followUp of aggregated.followUpTasks) {
      await deps.beads.createTask(followUp.title, epicId, {
        priority: followUp.priority,
        description: followUp.description,
      });
      totalTasks++;
    }
  }

  errors.push("Unexpected exit from main loop");
  return makeResult("failed", 0, currentLoop, 0);
}
