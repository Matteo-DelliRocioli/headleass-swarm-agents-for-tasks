import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runOrchestrator, type OrchestratorDeps, type SwarmRunResult } from "../../src/orchestrator.js";
import type { OrchestratorConfig } from "../../src/config.js";
import type { Persona } from "../../src/persona-loader.js";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../src/usage-tracker.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, UsageAccumulator: actual.UsageAccumulator };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    opencodeHost: "127.0.0.1",
    opencodePort: 4096,
    runName: "test-run",
    initialPrompt: "Build an Instagram clone",
    maxLoops: 3,
    confidenceThreshold: 0.85,
    model: "anthropic/claude-sonnet-4-20250514",
    personas: [],
    maxPlanLoops: 3,
    planApprovalThreshold: 0.8,
    mem0ApiUrl: "http://localhost:8080",
    workspacePath: tmpDir,
    personasPath: tmpDir + "/personas",
    swarmStatePath: tmpDir + "/.swarm",
    ...overrides,
  };
}

function makePersona(id: string, isReviewer: boolean): Persona {
  return { id, description: `${id} persona`, isReviewer, content: `# ${id}` };
}

function makeDeps(overrides: Partial<Record<keyof OrchestratorDeps, Record<string, unknown>>> = {}): OrchestratorDeps {
  let taskIdCounter = 0;

  const defaultBeads = {
    createEpic: vi.fn().mockResolvedValue("epic-1"),
    createTask: vi.fn().mockImplementation(() => Promise.resolve(`task-${++taskIdCounter}`)),
    addDependency: vi.fn().mockResolvedValue(undefined),
    getReadyTasks: vi.fn().mockResolvedValue([
      { id: "task-1", title: "Build the API", status: "open", priority: 1, description: "Build backend API" },
    ]),
    claimTask: vi.fn().mockResolvedValue(true),
  };

  const defaultAgents = {
    loadPersonas: vi.fn().mockResolvedValue(
      new Map([
        ["planner-agent", makePersona("planner-agent", true)],
        ["master-reviewer", makePersona("master-reviewer", true)],
        ["backend-dev", makePersona("backend-dev", false)],
        ["frontend-dev", makePersona("frontend-dev", false)],
        ["security-reviewer", makePersona("security-reviewer", true)],
      ]),
    ),
    matchPersonaToTask: vi.fn().mockImplementation((_title: string, _desc: string | undefined, personas: Map<string, Persona>) => {
      return personas.get("backend-dev");
    }),
    spawnPlanner: vi.fn().mockResolvedValue({
      sessionId: "planner-session-1",
      plan: {
        summary: "Instagram clone plan",
        tasks: [
          { title: "Build the API", description: "Build backend API", suggested_persona: "backend-dev", priority: 1 },
        ],
      },
    }),
    reviewPlan: vi.fn().mockResolvedValue({ approved: true, score: 0.9, feedback: "Good plan", issues: [] }),
    revisePlan: vi.fn().mockResolvedValue({ summary: "Revised", tasks: [] }),
    spawnAgent: vi.fn().mockResolvedValue({
      sessionId: "agent-session-1",
      persona: makePersona("backend-dev", false),
      task: { id: "task-1", title: "Build the API", status: "open", priority: 1 },
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    }),
    spawnReviewer: vi.fn().mockResolvedValue({
      score: 0.9,
      issues: [],
      usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
    }),
    aggregateReviews: vi.fn().mockReturnValue({
      confidence: 0.9,
      reviewCount: 1,
      perReviewer: [{ id: "security-reviewer", score: 0.9, issueCount: 0 }],
      criticalIssues: [],
      allIssues: [],
      followUpTasks: [],
    }),
  };

  const defaultInfra = {
    addMemory: vi.fn().mockResolvedValue(null),
    getQueueStats: vi.fn().mockResolvedValue({ pendingMessages: 0, urgentPending: 0, perAgent: {} }),
    drainQueue: vi.fn().mockResolvedValue(0),
    reportProgress: vi.fn().mockResolvedValue(undefined),
  };

  return {
    beads: { ...defaultBeads, ...(overrides as any).beads },
    agents: { ...defaultAgents, ...(overrides as any).agents },
    infra: { ...defaultInfra, ...(overrides as any).infra },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runOrchestrator — mock loop", () => {
  it("happy path — confidence met in 1 loop", async () => {
    const config = makeConfig();
    const deps = makeDeps();

    const result = await runOrchestrator(config, deps);

    expect(result.status).toBe("success");
    expect(result.loopsExecuted).toBe(1);
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("max loops reached — deferred tasks created", async () => {
    const config = makeConfig({ maxLoops: 2 });
    const deps = makeDeps({
      agents: {
        aggregateReviews: vi.fn().mockReturnValue({
          confidence: 0.6,
          reviewCount: 1,
          perReviewer: [{ id: "security-reviewer", score: 0.6, issueCount: 1 }],
          criticalIssues: [],
          allIssues: [],
          followUpTasks: [{ title: "Fix X", priority: 1, description: "Fix issue" }],
        }),
      },
    } as any);

    const result = await runOrchestrator(config, deps);

    expect(result.status).toBe("max_loops_reached");
    expect(result.loopsExecuted).toBe(2);
    expect(result.deferredTaskIds.length).toBeGreaterThanOrEqual(1);
  });

  it("no follow-ups terminates with success despite low confidence", async () => {
    const config = makeConfig();
    const deps = makeDeps({
      agents: {
        aggregateReviews: vi.fn().mockReturnValue({
          confidence: 0.7,
          reviewCount: 1,
          perReviewer: [{ id: "security-reviewer", score: 0.7, issueCount: 0 }],
          criticalIssues: [],
          allIssues: [],
          followUpTasks: [],
        }),
      },
    } as any);

    const result = await runOrchestrator(config, deps);

    expect(result.status).toBe("success");
  });

  it("plan review iteration — revisePlan called on rejection", async () => {
    const reviewPlanMock = vi
      .fn()
      .mockResolvedValueOnce({ approved: false, score: 0.5, feedback: "Needs work", issues: [{ severity: "high", description: "Missing auth" }] })
      .mockResolvedValueOnce({ approved: true, score: 0.85, feedback: "Good", issues: [] });

    const revisePlanMock = vi.fn().mockResolvedValue({
      summary: "Revised plan",
      tasks: [
        { title: "Build the API", description: "Build backend API", suggested_persona: "backend-dev", priority: 1 },
      ],
    });

    const deps = makeDeps({
      agents: {
        reviewPlan: reviewPlanMock,
        revisePlan: revisePlanMock,
      },
    } as any);

    const config = makeConfig();
    await runOrchestrator(config, deps);

    expect(reviewPlanMock).toHaveBeenCalledTimes(2);
    expect(revisePlanMock).toHaveBeenCalledTimes(1);
  });

  it("agent error handling — error captured, run continues to review", async () => {
    const spawnAgentMock = vi.fn().mockRejectedValueOnce(new Error("Connection refused"));

    const deps = makeDeps({
      agents: {
        spawnAgent: spawnAgentMock,
      },
    } as any);

    const config = makeConfig();
    const result = await runOrchestrator(config, deps);

    expect(result.errors.some((e) => e.includes("Connection refused"))).toBe(true);
    // Run should still complete (review phase runs even if agent fails)
    expect(result.marker).toBe("SWARM_RUN_COMPLETE");
  });

  it("unmatched task — fail-fast with failed status", async () => {
    const deps = makeDeps({
      agents: {
        matchPersonaToTask: vi.fn().mockReturnValue(undefined),
      },
    } as any);

    const config = makeConfig();
    const result = await runOrchestrator(config, deps);

    expect(result.status).toBe("failed");
    expect(result.errors[0]).toContain("Cannot match");
  });

  it("no personas found — immediate failure", async () => {
    const deps = makeDeps({
      agents: {
        loadPersonas: vi.fn().mockResolvedValue(new Map()),
      },
    } as any);

    const config = makeConfig();
    const result = await runOrchestrator(config, deps);

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.includes("No personas found"))).toBe(true);
  });
});
