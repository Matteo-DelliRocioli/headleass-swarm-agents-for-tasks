// ---------------------------------------------------------------------------
// Agent spawner — creates OpenCode sessions via SDK for each persona/task
// ---------------------------------------------------------------------------

import { logger } from "./logger.js";
import type { OrchestratorConfig } from "./config.js";
import type { Persona } from "./persona-loader.js";
import type { BeadsTask } from "./beads.js";
import { listTasks } from "./beads.js";
import { searchAll, formatMemoriesAsContext, type Mem0Config } from "./mem0.js";
import { extractUsage, type UsageData } from "./usage-tracker.js";

// The OpenCode SDK client type — we use dynamic import since it may not be
// available at compile time in all environments.
type OpenCodeClient = {
  session: {
    create: (opts: { body: { title: string } }) => Promise<{ id: string }>;
    prompt: (opts: {
      path: { id: string };
      body: {
        model?: { providerID: string; modelID: string };
        parts: Array<{ type: string; text: string }>;
        noReply?: boolean;
        format?: { type: string; schema?: unknown };
      };
    }) => Promise<unknown>;
  };
  event: {
    subscribe: () => Promise<{
      stream: AsyncIterable<{ type: string; properties: Record<string, unknown> }>;
    }>;
  };
};

let _client: OpenCodeClient | null = null;

async function getClient(config: OrchestratorConfig): Promise<OpenCodeClient> {
  if (_client) return _client;
  // Connect to an existing OpenCode server (don't spawn one)
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const client = createOpencodeClient({
    baseUrl: `http://${config.opencodeHost}:${config.opencodePort}`,
  });
  _client = client as unknown as OpenCodeClient;
  return _client;
}

/**
 * Extract session ID from SDK response.
 * The SDK returns { data: { id }, error, request, response } (hey-api wrapper).
 */
function getSessionId(session: unknown): string {
  const s = session as { id?: string; data?: { id?: string } } | null;
  return s?.id ?? s?.data?.id ?? "";
}

/**
 * Build the context string injected into each agent session.
 * Includes: task details, roster of active agents, swarm rules.
 */
async function buildAgentContext(
  persona: Persona,
  task: BeadsTask,
  config: OrchestratorConfig,
): Promise<string> {
  // Build roster of active agents
  const inProgress = await listTasks("in_progress");
  const roster = inProgress
    .filter(t => t.id !== task.id)
    .map(t => `- ${t.assignee ?? "unassigned"} is working on "${t.title}" (${t.id})`)
    .join("\n");

  // Fetch relevant shared memories from other agents in this run
  const mem0Config: Mem0Config = { apiUrl: config.mem0ApiUrl, runName: config.runName };
  let memoryContext = "";
  try {
    const taskQuery = `${task.title} ${task.description ?? ""}`.slice(0, 200);
    const memories = await searchAll(taskQuery, mem0Config, 10);
    memoryContext = formatMemoriesAsContext(memories);
  } catch {
    // Mem0 unavailable — proceed without shared memory
  }

  return `## Swarm Context

### Your Assignment
- **Task ID**: ${task.id}
- **Task**: ${task.title}
${task.description ? `- **Details**: ${task.description}` : ""}
- **Your Role**: ${persona.id} (${persona.description})

### Environment
- **SWARM_AGENT_ID**: ${persona.id}
- **SWARM_RUN_NAME**: ${config.runName}
- **MEM0_API_URL**: ${config.mem0ApiUrl}

### Active Agents
${roster || "No other agents currently active."}

${memoryContext ? memoryContext + "\n\n" : ""}### Rules
- You MUST claim your task before starting: use the beads-claim tool with task ID "${task.id}"
- When finished, close your task: use the beads-close tool with task ID "${task.id}"
- Do NOT modify files in .claude/ directories
- If you need to communicate with another agent, use **swarm-send** (they'll see it via **swarm-receive**)
- Check **swarm-receive** at the start of your task for messages from other agents
- Check **swarm-status** to see file locks before editing shared files
- Use **mem0-remember** to store key decisions, discoveries, or context for other agents
- Use **mem0-recall** to search for memories from other agents (scope "all") or your own (scope "own")

### Session Key
agent:${persona.id}:task:${task.id}
`;
}

// ---------------------------------------------------------------------------
// Planner types + spawn
// ---------------------------------------------------------------------------

export interface PlannedTask {
  title: string;
  description: string;
  suggested_persona: string;
  priority: number;
  depends_on?: string[];
}

export interface PlannerOutput {
  summary: string;
  tasks: PlannedTask[];
}

const PLANNER_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          suggested_persona: { type: "string" },
          priority: { type: "number", minimum: 0, maximum: 4 },
          depends_on: { type: "array", items: { type: "string" } },
        },
        required: ["title", "description", "suggested_persona", "priority"],
      },
    },
  },
  required: ["summary", "tasks"],
} as const;

export interface PlannerSession {
  sessionId: string;
  plan: PlannerOutput;
}

/**
 * Spawn the planner agent to decompose a prompt into subtasks.
 * Returns both the plan AND the session ID, so the orchestrator can
 * continue the session for revision if the plan is rejected.
 */
export async function spawnPlanner(
  persona: Persona,
  initialPrompt: string,
  config: OrchestratorConfig,
): Promise<PlannerSession> {
  const client = await getClient(config);
  const sessionTitle = `agent:planner:decompose`;

  logger.info("Spawning planner agent", { prompt: initialPrompt.slice(0, 100) });

  const session = await client.session.create({
    body: { title: sessionTitle },
  });

  // Inject persona context (noReply = don't trigger response yet)
  await client.session.prompt({
    path: { id: getSessionId(session) },
    body: {
      noReply: true,
      parts: [{
        type: "text",
        text: `## Planner Context\n\n${persona.content}\n\n### Available Personas\nfrontend-dev, backend-dev, devops-agent, test-writer, database-specialist\n\n### Workspace\nExplore /workspace to understand the codebase before planning.`,
      }],
    },
  });

  // Send the decomposition prompt with structured output format
  const [provider, model] = config.model.includes("/")
    ? config.model.split("/", 2)
    : ["anthropic", config.model];

  const response = await client.session.prompt({
    path: { id: getSessionId(session) },
    body: {
      model: { providerID: provider, modelID: model },
      parts: [{
        type: "text",
        text: `Decompose this prompt into implementation tasks:\n\n---\n${initialPrompt}\n---\n\nExplore the workspace first, then output your structured task plan as JSON.`,
      }],
      format: {
        type: "json_schema",
        schema: PLANNER_JSON_SCHEMA,
      },
    },
  });

  const plan = extractPlannerOutput(response);

  logger.info("Planner completed", {
    sessionId: getSessionId(session),
    taskCount: plan.tasks.length,
    summary: plan.summary,
  });

  return { sessionId: getSessionId(session), plan };
}

// ---------------------------------------------------------------------------
// Plan review + revision (iterative plan↔review loop)
// ---------------------------------------------------------------------------

export interface PlanReviewResult {
  approved: boolean;
  score: number;
  feedback: string;
  issues: Array<{ task_title: string; issue: string }>;
}

const PLAN_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    feedback: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task_title: { type: "string" },
          issue: { type: "string" },
        },
        required: ["task_title", "issue"],
      },
    },
  },
  required: ["approved", "score", "feedback"],
} as const;

/**
 * Spawn the master-reviewer to evaluate a plan before it goes to implementation.
 * Checks: task clarity, persona assignments, dependency structure, scope.
 */
export async function reviewPlan(
  plan: PlannerOutput,
  reviewerPersona: Persona,
  config: OrchestratorConfig,
): Promise<PlanReviewResult> {
  const client = await getClient(config);
  const sessionTitle = `agent:plan-reviewer:evaluate`;

  logger.info("Spawning plan reviewer", { taskCount: plan.tasks.length });

  const session = await client.session.create({
    body: { title: sessionTitle },
  });

  const planJson = JSON.stringify(plan, null, 2);

  const [provider, model] = config.model.includes("/")
    ? config.model.split("/", 2)
    : ["anthropic", config.model];

  const response = await client.session.prompt({
    path: { id: getSessionId(session) },
    body: {
      model: { providerID: provider, modelID: model },
      parts: [{
        type: "text",
        text: `You are reviewing a task decomposition plan before it goes to implementation agents.

## Available Personas
frontend-dev, backend-dev, devops-agent, test-writer, database-specialist

## Plan to Review
\`\`\`json
${planJson}
\`\`\`

## Evaluation Criteria
1. **Task clarity**: Is each task description clear enough for a single agent to implement without follow-up questions?
2. **Persona fit**: Is each task assigned to the right specialist? (e.g., database work → database-specialist, not frontend-dev)
3. **Dependencies**: Are dependency edges correct and acyclic? Are missing dependencies that would cause build failures?
4. **Scope**: Is the decomposition too fine-grained (>12 tasks) or too coarse (single task for complex work)?
5. **Completeness**: Does the plan cover the full prompt, or are parts missing?
6. **Priority**: Are priorities sensible? Critical path items should be P0/P1.

Score 0.8+ means the plan is good enough to execute. Below 0.8 means it needs revision.
Provide specific, actionable feedback referencing task titles.`,
      }],
      format: {
        type: "json_schema",
        schema: PLAN_REVIEW_SCHEMA,
      },
    },
  });

  const result = extractPlanReview(response);

  logger.info("Plan review completed", {
    approved: result.approved,
    score: result.score,
    issueCount: result.issues.length,
  });

  return result;
}

function extractPlanReview(response: unknown): PlanReviewResult {
  const res = response as Record<string, unknown> | null;
  const fallback: PlanReviewResult = { approved: true, score: 0.8, feedback: "Review parse failed — auto-approving", issues: [] };

  if (!res) return fallback;

  // Try common response shapes
  let raw: Record<string, unknown> | undefined;

  if (typeof res.content === "string") {
    try { raw = JSON.parse(res.content); } catch { /* fall through */ }
  }
  if (!raw && Array.isArray(res.parts)) {
    for (const part of res.parts) {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") {
        try { raw = JSON.parse(p.text); break; } catch { /* fall through */ }
      }
    }
  }
  if (!raw && res.result && typeof res.result === "object") {
    raw = res.result as Record<string, unknown>;
  }
  if (!raw && typeof res.approved === "boolean") {
    raw = res as Record<string, unknown>;
  }

  if (!raw) {
    logger.warn("Could not parse plan review response — auto-approving");
    return fallback;
  }

  return {
    approved: typeof raw.approved === "boolean" ? raw.approved : true,
    score: typeof raw.score === "number" ? Math.max(0, Math.min(1, raw.score)) : 0.8,
    feedback: typeof raw.feedback === "string" ? raw.feedback : "",
    issues: Array.isArray(raw.issues)
      ? (raw.issues as Array<Record<string, unknown>>)
          .filter(i => typeof i.task_title === "string" && typeof i.issue === "string")
          .map(i => ({ task_title: i.task_title as string, issue: i.issue as string }))
      : [],
  };
}

/**
 * Send review feedback to an existing planner session and get a revised plan.
 * The planner session retains context from previous iterations.
 */
export async function revisePlan(
  plannerSessionId: string,
  review: PlanReviewResult,
  iteration: number,
  config: OrchestratorConfig,
): Promise<PlannerOutput> {
  const client = await getClient(config);

  const issueList = review.issues.length > 0
    ? review.issues.map(i => `- **${i.task_title}**: ${i.issue}`).join("\n")
    : "(no specific task issues)";

  logger.info("Requesting plan revision", { iteration, score: review.score, issueCount: review.issues.length });

  const [provider, model] = config.model.includes("/")
    ? config.model.split("/", 2)
    : ["anthropic", config.model];

  const response = await client.session.prompt({
    path: { id: plannerSessionId },
    body: {
      model: { providerID: provider, modelID: model },
      parts: [{
        type: "text",
        text: `## Plan Review Feedback (iteration ${iteration})

**Score**: ${review.score}/1.0
**Verdict**: ${review.approved ? "Approved with suggestions" : "Revision needed"}

### Feedback
${review.feedback}

### Specific Issues
${issueList}

Please revise your plan to address this feedback. Output the complete revised plan as JSON (same format as before).`,
      }],
      format: {
        type: "json_schema",
        schema: PLANNER_JSON_SCHEMA,
      },
    },
  });

  const plan = extractPlannerOutput(response);

  logger.info("Plan revision completed", {
    iteration,
    taskCount: plan.tasks.length,
    summary: plan.summary,
  });

  return plan;
}

/**
 * Parse the planner's structured JSON response.
 * The OpenCode SDK returns the formatted response; exact shape depends on SDK version.
 */
function extractPlannerOutput(response: unknown): PlannerOutput {
  // Try direct JSON content extraction from common response shapes
  let res = response as Record<string, unknown> | null;

  if (!res) {
    logger.warn("Planner returned null response, using empty plan");
    return { summary: "Empty plan — planner returned no output", tasks: [] };
  }

  // Unwrap SDK wrapper: { data, error, request, response }
  if (res.data && typeof res.data === "object" && !res.tasks && !res.parts) {
    res = res.data as Record<string, unknown>;
  }

  // Shape 1: { content: string } — raw JSON string
  if (typeof res.content === "string") {
    try {
      return JSON.parse(res.content) as PlannerOutput;
    } catch { /* fall through */ }
  }

  // Shape 2: { parts: [{ text: string }] } — message parts
  if (Array.isArray(res.parts)) {
    for (const part of res.parts) {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") {
        try {
          return JSON.parse(p.text) as PlannerOutput;
        } catch { /* fall through */ }
      }
    }
  }

  // Shape 3: { result: { ... } } — already parsed
  if (res.result && typeof res.result === "object") {
    const result = res.result as Record<string, unknown>;
    if (Array.isArray(result.tasks)) {
      return result as unknown as PlannerOutput;
    }
  }

  // Shape 4: direct object with tasks array
  if (Array.isArray(res.tasks)) {
    return res as unknown as PlannerOutput;
  }

  logger.warn("Could not parse planner response, using empty plan", {
    responseKeys: Object.keys(res),
    error: res.error ? JSON.stringify(res.error).slice(0, 500) : undefined,
    response: res.response ? JSON.stringify(res.response).slice(0, 500) : undefined,
  });
  return { summary: "Failed to parse planner output", tasks: [] };
}

// ---------------------------------------------------------------------------
// Implementation + review agent types + spawn
// ---------------------------------------------------------------------------

export interface SpawnResult {
  sessionId: string;
  persona: Persona;
  task: BeadsTask;
  usage: UsageData;
}

/**
 * Spawn an implementation agent for a specific task.
 */
export async function spawnAgent(
  persona: Persona,
  task: BeadsTask,
  config: OrchestratorConfig,
): Promise<SpawnResult> {
  const client = await getClient(config);
  const sessionTitle = `agent:${persona.id}:task:${task.id}`;

  logger.info("Spawning agent", { persona: persona.id, task: task.id, session: sessionTitle });

  // Create session
  const session = await client.session.create({
    body: { title: sessionTitle },
  });

  // Inject context (noReply = don't trigger AI response yet)
  const context = await buildAgentContext(persona, task, config);
  await client.session.prompt({
    path: { id: getSessionId(session) },
    body: {
      noReply: true,
      parts: [{ type: "text", text: context }],
    },
  });

  // Send the actual task prompt
  const [provider, model] = config.model.includes("/")
    ? config.model.split("/", 2)
    : ["anthropic", config.model];

  const response = await client.session.prompt({
    path: { id: getSessionId(session) },
    body: {
      model: { providerID: provider, modelID: model },
      parts: [{ type: "text", text: task.description ?? task.title }],
    },
  });

  const usage = extractUsage(response);
  logger.info("Agent spawned", { sessionId: getSessionId(session), persona: persona.id, task: task.id, tokens: usage.totalTokens });
  return { sessionId: getSessionId(session), persona, task, usage };
}

export interface ReviewerOutput {
  sessionId: string;
  persona: Persona;
  score: number;
  issues: Array<{
    severity: "critical" | "high" | "medium" | "low";
    file?: string;
    line?: number;
    description: string;
  }>;
  usage: UsageData;
}

const REVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number", minimum: 0, maximum: 1 },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          file: { type: "string" },
          line: { type: "number" },
          description: { type: "string" },
        },
        required: ["severity", "description"],
      },
    },
  },
  required: ["score", "issues"],
} as const;

/**
 * Spawn a review agent (read-only).
 * Captures and returns structured JSON review output.
 */
export async function spawnReviewer(
  persona: Persona,
  loopNumber: number,
  config: OrchestratorConfig,
): Promise<ReviewerOutput> {
  const client = await getClient(config);
  const sessionTitle = `agent:${persona.id}:review:loop-${loopNumber}`;

  logger.info("Spawning reviewer", { persona: persona.id, loop: loopNumber });

  const session = await client.session.create({
    body: { title: sessionTitle },
  });

  // Fetch shared memory to give reviewers context from implementation agents
  const mem0Config: Mem0Config = { apiUrl: config.mem0ApiUrl, runName: config.runName };
  let memoryContext = "";
  try {
    const memories = await searchAll("implementation decisions and changes", mem0Config, 15);
    memoryContext = formatMemoriesAsContext(memories);
  } catch {
    // Mem0 unavailable — proceed without shared memory
  }

  // Inject review context with persona instructions + shared memory
  await client.session.prompt({
    path: { id: getSessionId(session) },
    body: {
      noReply: true,
      parts: [{
        type: "text",
        text: `## Review Context\n\n${persona.content}\n\nYou are reviewing loop ${loopNumber} of a swarm run.\nReview all changed files in /workspace and provide your assessment.\nOutput your review as JSON with a score (0-1) and issues array.\n\n${memoryContext}`,
      }],
    },
  });

  // Request structured review output
  const [provider, model] = config.model.includes("/")
    ? config.model.split("/", 2)
    : ["anthropic", config.model];

  const response = await client.session.prompt({
    path: { id: getSessionId(session) },
    body: {
      model: { providerID: provider, modelID: model },
      parts: [{ type: "text", text: "Review all changes made in this workspace. Analyze code quality, security, and architecture. Output your structured review." }],
      format: {
        type: "json_schema",
        schema: REVIEW_JSON_SCHEMA,
      },
    },
  });

  // Parse the structured review output and extract usage
  const parsed = extractReviewOutput(response, persona.id);
  const usage = extractUsage(response);

  logger.info("Reviewer completed", {
    sessionId: getSessionId(session),
    persona: persona.id,
    score: parsed.score,
    issueCount: parsed.issues.length,
    tokens: usage.totalTokens,
  });

  return {
    sessionId: getSessionId(session),
    persona,
    score: parsed.score,
    issues: parsed.issues,
    usage,
  };
}

/**
 * Parse the reviewer's structured JSON response.
 * Falls back to score 0.5 (neutral) with empty issues on parse failure.
 */
function extractReviewOutput(
  response: unknown,
  reviewerId: string,
): { score: number; issues: ReviewerOutput["issues"] } {
  let res = response as Record<string, unknown> | null;
  const fallback = { score: 0.5, issues: [] as ReviewerOutput["issues"] };

  if (!res) {
    logger.warn("Reviewer returned null response", { reviewerId });
    return fallback;
  }

  // Unwrap SDK wrapper: { data, error, request, response }
  if (res.data && typeof res.data === "object" && !res.score && !res.parts) {
    res = res.data as Record<string, unknown>;
  }

  // Try common response shapes (same as planner extraction)
  let raw: Record<string, unknown> | undefined;

  if (typeof res.content === "string") {
    try { raw = JSON.parse(res.content); } catch { /* fall through */ }
  }

  if (!raw && Array.isArray(res.parts)) {
    for (const part of res.parts) {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") {
        try { raw = JSON.parse(p.text); break; } catch { /* fall through */ }
      }
    }
  }

  if (!raw && res.result && typeof res.result === "object") {
    raw = res.result as Record<string, unknown>;
  }

  if (!raw && typeof res.score === "number") {
    raw = res as Record<string, unknown>;
  }

  if (!raw) {
    logger.warn("Could not parse reviewer response", {
      reviewerId,
      responseKeys: Object.keys(res),
      error: res.error ? JSON.stringify(res.error).slice(0, 500) : undefined,
      response: res.response ? JSON.stringify(res.response).slice(0, 500) : undefined,
    });
    return fallback;
  }

  // Validate and extract score
  const score = typeof raw.score === "number"
    ? Math.max(0, Math.min(1, raw.score))
    : 0.5;

  // Validate and extract issues
  const issues: ReviewerOutput["issues"] = [];
  if (Array.isArray(raw.issues)) {
    for (const item of raw.issues) {
      const i = item as Record<string, unknown>;
      if (typeof i.description === "string" && typeof i.severity === "string") {
        issues.push({
          severity: i.severity as ReviewerOutput["issues"][number]["severity"],
          description: i.description,
          file: typeof i.file === "string" ? i.file : undefined,
          line: typeof i.line === "number" ? i.line : undefined,
        });
      }
    }
  }

  return { score, issues };
}

/** @internal — exported for testing */
export { extractPlannerOutput as _extractPlannerOutput };
/** @internal — exported for testing */
export { extractReviewOutput as _extractReviewOutput };
