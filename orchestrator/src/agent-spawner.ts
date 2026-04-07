// ---------------------------------------------------------------------------
// Agent spawner — creates OpenCode sessions via SDK for each persona/task
// ---------------------------------------------------------------------------

import { logger } from "./logger.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrchestratorConfig } from "./config.js";
import type { Persona } from "./persona-loader.js";
import type { BeadsTask } from "./beads.js";
import { listTasks } from "./beads.js";
import { searchAll, formatMemoriesAsContext, type Mem0Config } from "./mem0.js";
import { type UsageData } from "./usage-tracker.js";
import {
  openCompletionWaiter,
  extractTextFromParts,
  parseJsonFromText,
  type CompletedMessage,
  type MessagePart,
} from "./llm-wait.js";

/**
 * Read structured output that was written by a submit_* tool.
 * Returns null if the file doesn't exist (LLM forgot to call the tool —
 * caller should fall back to text parsing).
 */
async function readSubmittedOutput<T>(
  swarmStatePath: string,
  category: "plans" | "plan-reviews" | "reviews",
  sessionID: string,
): Promise<T | null> {
  const filePath = join(swarmStatePath, category, `${sessionID}.json`);
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// The OpenCode SDK client type — we use dynamic import since it may not be
// available at compile time in all environments.
//
// Note: session.prompt() is fire-and-forget in OpenCode v1.x. The actual
// LLM response comes via SSE events on /event. See llm-wait.ts for the
// completion-waiting helper.
// Part types for prompts. OpenCode v1.x supports text, agent (@mention), and
// subtask (delegated subagent invocation).
type PromptPart =
  | { type: "text"; text: string }
  | { type: "agent"; name: string }
  | { type: "subtask"; prompt: string; description: string; agent: string };

type OpenCodeClient = {
  session: {
    create: (opts: { body: { title: string } }) => Promise<unknown>;
    prompt: (opts: {
      path: { id: string };
      body: {
        model?: { providerID: string; modelID: string };
        agent?: string;        // selects which persona to use
        system?: string;       // system prompt (replaces noReply context injection)
        tools?: Record<string, boolean>;
        parts: PromptPart[];
        noReply?: boolean;
      };
    }) => Promise<unknown>;
    messages: (opts: { path: { id: string } }) => Promise<unknown>;
  };
  event: {
    subscribe: () => Promise<{
      stream: AsyncIterable<unknown>;
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
 * Extract usage data from a CompletedMessage (from llm-wait.ts).
 * The OpenCode AssistantMessage has tokens.input and tokens.output.
 */
function usageFromMessage(completed: CompletedMessage): UsageData {
  const input = completed.tokens?.input ?? 0;
  const output = completed.tokens?.output ?? 0;
  return { inputTokens: input, outputTokens: output, totalTokens: input + output };
}

/**
 * Resolve which model to use for a persona. Priority:
 * 1. Persona's `model` frontmatter field
 * 2. Falls back to config.model (the global SWARM_MODEL env var)
 *
 * Returns { providerID, modelID } parsed from "provider/model" format.
 */
function resolveModel(
  persona: Persona,
  config: OrchestratorConfig,
): { providerID: string; modelID: string } {
  const modelStr = persona.model ?? config.model;
  if (modelStr.includes("/")) {
    const [providerID, modelID] = modelStr.split("/", 2);
    return { providerID, modelID };
  }
  return { providerID: "anthropic", modelID: modelStr };
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

  const sessionId = getSessionId(session);

  // Send the decomposition prompt — use agent + system fields to invoke the
  // planner persona properly (no more noReply context injection hack).
  const { providerID, modelID } = resolveModel(persona, config);

  const systemPrompt = `${persona.content}

## Available Personas
- frontend-dev: React, TypeScript, CSS, HTML, UI/UX
- backend-dev: APIs, server logic, auth, endpoints
- database-specialist: Schema, migrations, queries
- test-writer: Unit, integration, e2e tests
- devops-agent: Docker, CI/CD, deployment

## How to Submit Your Plan
You MUST call the \`submit_plan\` tool with your structured plan as the FINAL action.
The tool's args ARE the plan. Do not also output JSON in your message text.
The orchestrator reads the tool's structured args directly — message text is ignored.`;

  // Open SSE waiter BEFORE sending the prompt to avoid missing the completion event.
  // Pass the expected output file so the wait function knows when the agent is REALLY done
  // (multi-step agents may emit several intermediate session.idle events).
  const expectedPlanFile = `${config.swarmStatePath}/plans/${sessionId}.json`;
  const { wait } = await openCompletionWaiter(client, sessionId, 600_000, expectedPlanFile);
  await client.session.prompt({
    path: { id: sessionId },
    body: {
      model: { providerID, modelID },
      agent: persona.id,
      system: systemPrompt,
      parts: [{
        type: "text",
        text: `Decompose this prompt into implementation tasks:

---
${initialPrompt}
---

## Steps
1. Explore the workspace BRIEFLY (read package.json, glob top-level dirs). Don't read every file.
2. Identify components and decide on task decomposition.
3. For multi-component prompts (backend + frontend, API + database), include an integration task.
4. Call the \`submit_plan\` tool with your final plan. The tool's args ARE the plan.

Do NOT output JSON in your message text — call the tool instead.`,
      }],
    },
  });
  const completed = await wait;

  // Try to read the plan from the file written by submit_plan tool first
  const submitted = await readSubmittedOutput<PlannerOutput>(
    config.swarmStatePath,
    "plans",
    sessionId,
  );

  let plan: PlannerOutput;
  if (submitted && Array.isArray(submitted.tasks) && submitted.tasks.length > 0) {
    plan = submitted;
    logger.info("Planner submitted plan via tool", { sessionId, taskCount: plan.tasks.length });
  } else {
    // Fallback: parse from message text (legacy path)
    plan = extractPlannerOutput(completed.parts);
    if (plan.tasks.length > 0) {
      logger.warn("Planner did not call submit_plan tool — used text fallback", { sessionId, taskCount: plan.tasks.length });
    }
  }

  logger.info("Planner completed", {
    sessionId,
    taskCount: plan.tasks.length,
    summary: plan.summary,
    tokens: usageFromMessage(completed).totalTokens,
  });

  return { sessionId, plan };
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

  const { providerID, modelID } = resolveModel(reviewerPersona, config);

  const sessionId = getSessionId(session);

  const systemPrompt = `${reviewerPersona.content}

## How to Submit Your Review
You MUST call the \`submit_plan_review\` tool with your structured assessment as the FINAL action.
The tool's args ARE the review. Do not also output JSON in your message text.
The orchestrator reads the tool's structured args directly — message text is ignored.`;

  const expectedReviewFile = `${config.swarmStatePath}/plan-reviews/${sessionId}.json`;
  const { wait } = await openCompletionWaiter(client, sessionId, 600_000, expectedReviewFile);
  await client.session.prompt({
    path: { id: sessionId },
    body: {
      model: { providerID, modelID },
      agent: reviewerPersona.id,
      system: systemPrompt,
      parts: [{
        type: "text",
        text: `Review this task decomposition plan:

## Available Personas
frontend-dev, backend-dev, devops-agent, test-writer, database-specialist

## Plan to Review
\`\`\`json
${planJson}
\`\`\`

## Evaluation Criteria
1. **Task clarity**: clear enough for a single agent to implement without follow-up?
2. **Persona fit**: right specialist? (database work → database-specialist, not frontend-dev)
3. **Dependencies**: correct and acyclic? any missing that would cause build failures?
4. **Scope**: too fine-grained (>12 tasks) or too coarse (single task for complex work)?
5. **Completeness**: covers the full prompt?
6. **Priority**: sensible? critical path items P0/P1?
7. **Domain separation**: backend and frontend work in SEPARATE tasks?
8. **Integration tasks**: are there tasks to wire components together?

Score 0.8+ means good to execute. Below 0.8 needs revision.

Call \`submit_plan_review\` with your assessment as your final action.`,
      }],
    },
  });
  const completed = await wait;

  // Try to read the review from the file written by submit_plan_review tool
  const submitted = await readSubmittedOutput<{
    approved: boolean;
    score: number;
    feedback: string;
    issues: Array<{ task_title: string; issue: string }>;
  }>(config.swarmStatePath, "plan-reviews", sessionId);

  let result: PlanReviewResult;
  if (submitted) {
    result = {
      approved: submitted.approved,
      score: submitted.score,
      feedback: submitted.feedback,
      issues: submitted.issues ?? [],
    };
    logger.info("Plan reviewer submitted via tool", { sessionId, score: result.score });
  } else {
    // Fallback: parse from message text
    result = extractPlanReview(completed.parts);
    logger.warn("Plan reviewer did not call submit_plan_review tool — used text fallback", { sessionId });
  }

  logger.info("Plan review completed", {
    approved: result.approved,
    score: result.score,
    issueCount: result.issues.length,
    tokens: usageFromMessage(completed).totalTokens,
  });

  return result;
}

function extractPlanReview(parts: MessagePart[]): PlanReviewResult {
  const fallback: PlanReviewResult = {
    approved: true,
    score: 0.8,
    feedback: "Review parse failed — auto-approving",
    issues: [],
  };

  const text = extractTextFromParts(parts);
  if (!text) {
    logger.warn("Plan review returned empty text — auto-approving");
    return fallback;
  }

  const raw = parseJsonFromText<Record<string, unknown>>(text);
  if (!raw) {
    logger.warn("Could not parse plan review JSON — auto-approving", { textPreview: text.slice(0, 200) });
    return fallback;
  }

  return {
    approved: typeof raw.approved === "boolean" ? raw.approved : true,
    score: typeof raw.score === "number" ? Math.max(0, Math.min(1, raw.score)) : 0.8,
    feedback: typeof raw.feedback === "string" ? raw.feedback : "",
    issues: Array.isArray(raw.issues)
      ? (raw.issues as Array<Record<string, unknown>>)
          .filter((i) => typeof i.task_title === "string" && typeof i.issue === "string")
          .map((i) => ({ task_title: i.task_title as string, issue: i.issue as string }))
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
  plannerPersona?: Persona,
): Promise<PlannerOutput> {
  const client = await getClient(config);

  const issueList = review.issues.length > 0
    ? review.issues.map(i => `- **${i.task_title}**: ${i.issue}`).join("\n")
    : "(no specific task issues)";

  logger.info("Requesting plan revision", { iteration, score: review.score, issueCount: review.issues.length });

  // Use planner persona's model if available, else fall back to config
  const { providerID, modelID } = plannerPersona
    ? resolveModel(plannerPersona, config)
    : (config.model.includes("/")
        ? { providerID: config.model.split("/", 2)[0], modelID: config.model.split("/", 2)[1] }
        : { providerID: "anthropic", modelID: config.model });

  // Delete the existing plan file (from the first spawnPlanner call) so the
  // existence check in openCompletionWaiter triggers on the new submission.
  const expectedPlanFile = `${config.swarmStatePath}/plans/${plannerSessionId}.json`;
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(expectedPlanFile);
  } catch {
    // File didn't exist — fine
  }

  const { wait } = await openCompletionWaiter(client, plannerSessionId, 600_000, expectedPlanFile);
  await client.session.prompt({
    path: { id: plannerSessionId },
    body: {
      model: { providerID, modelID },
      agent: "planner-agent",
      parts: [{
        type: "text",
        text: `## Plan Review Feedback (iteration ${iteration})

**Score**: ${review.score}/1.0
**Verdict**: ${review.approved ? "Approved with suggestions" : "Revision needed"}

### Feedback
${review.feedback}

### Specific Issues
${issueList}

Revise your plan to address this feedback. Call the \`submit_plan\` tool with your revised plan as your final action. The tool's args ARE the plan — do not output JSON in your message text.`,
      }],
    },
  });
  const completed = await wait;

  // Try to read the revised plan from the file written by submit_plan tool
  const submitted = await readSubmittedOutput<PlannerOutput>(
    config.swarmStatePath,
    "plans",
    plannerSessionId,
  );

  let plan: PlannerOutput;
  if (submitted && Array.isArray(submitted.tasks) && submitted.tasks.length > 0) {
    plan = submitted;
    logger.info("Plan revision submitted via tool", { iteration, taskCount: plan.tasks.length });
  } else {
    plan = extractPlannerOutput(completed.parts);
    logger.warn("Plan revision did not call submit_plan tool — used text fallback", { iteration });
  }

  logger.info("Plan revision completed", {
    iteration,
    taskCount: plan.tasks.length,
    summary: plan.summary,
  });

  return plan;
}

/**
 * Parse the planner's structured JSON output from an assistant message's parts.
 * Concatenates all TextParts and tries: direct JSON parse, then fenced code block,
 * then any { ... } block in the text.
 */
function extractPlannerOutput(parts: MessagePart[]): PlannerOutput {
  if (!Array.isArray(parts) || parts.length === 0) {
    logger.warn("Planner returned empty parts, using empty plan");
    return { summary: "Empty plan — planner returned no output", tasks: [] };
  }

  const text = extractTextFromParts(parts);
  if (!text) {
    logger.warn("Planner parts contained no text, using empty plan");
    return { summary: "Empty plan — no text in planner output", tasks: [] };
  }

  const parsed = parseJsonFromText<PlannerOutput>(text);
  if (parsed && Array.isArray(parsed.tasks)) {
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "(no summary)",
      tasks: parsed.tasks,
    };
  }

  logger.warn("Could not parse planner JSON, using empty plan", {
    textPreview: text.slice(0, 300),
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

  const sessionId = getSessionId(session);

  // Build the context as a system prompt (replaces noReply injection)
  const context = await buildAgentContext(persona, task, config);
  const systemPrompt = `${persona.content}

${context}`;

  // Send the actual task prompt with agent + system fields
  const { providerID, modelID } = resolveModel(persona, config);

  const { wait } = await openCompletionWaiter(client, sessionId);
  await client.session.prompt({
    path: { id: sessionId },
    body: {
      model: { providerID, modelID },
      agent: persona.id,
      system: systemPrompt,
      parts: [{ type: "text", text: task.description ?? task.title }],
    },
  });
  const completed = await wait;

  const usage = usageFromMessage(completed);
  logger.info("Agent spawned", { sessionId, persona: persona.id, task: task.id, tokens: usage.totalTokens });
  return { sessionId, persona, task, usage };
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

  const sessionId = getSessionId(session);

  // Fetch shared memory to give reviewers context from implementation agents
  const mem0Config: Mem0Config = { apiUrl: config.mem0ApiUrl, runName: config.runName };
  let memoryContext = "";
  try {
    const memories = await searchAll("implementation decisions and changes", mem0Config, 15);
    memoryContext = formatMemoriesAsContext(memories);
  } catch {
    // Mem0 unavailable — proceed without shared memory
  }

  // qa-evaluator is fundamentally different from the static reviewers — it
  // needs to actually start the app and test it functionally, not just inspect
  // the diff. Branch on persona id to send the right prompt and timeout.
  const isFunctionalReviewer = persona.id === "qa-evaluator";

  const submitInstructions = `## How to Submit Your Review
You MUST call the \`submit_review\` tool with your structured assessment as the FINAL action.
The tool's args ARE the review (score + issues). Do not also output JSON in your message text.
The orchestrator reads the tool's structured args directly — message text is ignored.`;

  const staticReviewerRules = `## Efficiency Rules (CRITICAL — to avoid timeout)
- Use \`bash: git diff HEAD~1\` to see ONLY the changes made in the last commit
- Do NOT read every file in /workspace — read only the files that changed
- Do NOT use glob or grep to enumerate the whole tree
- Spend at most 2-3 tool calls before submitting your review`;

  const qaEvaluatorRules = `## Functional Testing Rules (you are the ONLY reviewer that runs the app)
- Read package.json to find the start/dev script
- Start the app in BACKGROUND with bash (e.g. \`PORT=3999 nohup node src/app.js > /tmp/app.log 2>&1 & echo $!\`)
- IMPORTANT: use a NON-STANDARD port (3999 or higher) to avoid collisions
- Wait for readiness: \`sleep 2 && curl -sf http://localhost:3999/health\` (or appropriate path)
- Test the changed endpoints with curl: capture HTTP status codes and response bodies
- Test the homepage: \`curl -sI http://localhost:3999/\` — should return 200 with Content-Type: text/html
- KILL the server when done: \`kill <PID>\` (use the PID you saved when starting)
- Score 0.0-0.1 if app fails to start, 0.2-0.4 if core feature broken, 0.6-0.8 if minor issues, 0.9-1.0 if all tests pass
- Read /tmp/app.log if you need to see the server's stderr after a failure
- You have 10 minutes — use them. Static code review is NOT your job; the other reviewers do that.`;

  const reviewerRules = isFunctionalReviewer ? qaEvaluatorRules : staticReviewerRules;

  // Build system prompt with persona instructions + shared memory + role-specific rules
  const systemPrompt = `${persona.content}

You are reviewing loop ${loopNumber} of a swarm run. The implementation agents have made changes to /workspace.

${memoryContext}

${submitInstructions}

${reviewerRules}`;

  // Request structured review output via agent + system fields
  const { providerID, modelID } = resolveModel(persona, config);

  // Static reviewers: 5 min. qa-evaluator: 10 min (needs to start the app, test endpoints, clean up)
  const reviewerTimeoutMs = isFunctionalReviewer ? 10 * 60 * 1000 : 5 * 60 * 1000;
  // Pass expected output file so multi-step agents (especially qa-evaluator)
  // don't resolve on intermediate session.idle events.
  const expectedReviewFile = `${config.swarmStatePath}/reviews/${sessionId}.json`;
  const { wait } = await openCompletionWaiter(client, sessionId, reviewerTimeoutMs, expectedReviewFile);

  const userPrompt = isFunctionalReviewer
    ? `Run the application and test the changed features.

## Steps
1. \`cat package.json\` — find the start script
2. \`git log --oneline -3\` and \`git diff HEAD~1\` (or HEAD if only one commit) — see what changed
3. Start the app in background on PORT=3999 (or whatever doesn't collide). Capture the PID.
4. Wait for readiness (sleep 2 then curl the health endpoint with --retry 5 --retry-delay 1)
5. Test EACH changed endpoint with curl. Capture status codes + response previews.
6. Smoke-test the homepage (\`curl -sI\` for headers, \`curl -s | head -20\` for body)
7. Kill the server: \`kill <pid>\`
8. Call \`submit_review\` with your assessment + evidence

If the app fails to start, that's a critical issue with score ≤ 0.1 — submit immediately, don't try to fix it.
If endpoints return 4xx/5xx unexpectedly, that's a critical/high issue with score ≤ 0.4.
If everything works, score 0.95.`
    : `Review the changes from this loop.

## How to be efficient
1. Run \`git diff HEAD~1\` (or \`git diff HEAD\` if there's only one commit) to see ONLY the changes
2. Read at most 3-5 files that look most relevant to your specialty
3. Call the \`submit_review\` tool with your assessment

Do NOT explore the whole workspace. Focus on what changed.
Do NOT output JSON in your message text — call the tool instead.
Your review will be submitted via the tool's args (score + issues).`;

  await client.session.prompt({
    path: { id: sessionId },
    body: {
      model: { providerID, modelID },
      agent: persona.id,
      system: systemPrompt,
      parts: [{ type: "text", text: userPrompt }],
    },
  });
  const completed = await wait;

  // Try to read the review from the file written by submit_review tool
  const submitted = await readSubmittedOutput<{
    score: number;
    issues: ReviewerOutput["issues"];
  }>(config.swarmStatePath, "reviews", sessionId);

  let parsed: { score: number; issues: ReviewerOutput["issues"] };
  if (submitted) {
    parsed = {
      score: typeof submitted.score === "number" ? Math.max(0, Math.min(1, submitted.score)) : 0.5,
      issues: Array.isArray(submitted.issues) ? submitted.issues : [],
    };
    logger.info("Reviewer submitted via tool", { sessionId, persona: persona.id, score: parsed.score });
  } else {
    // Fallback: parse from message text
    parsed = extractReviewOutput(completed.parts, persona.id);
    logger.warn("Reviewer did not call submit_review tool — used text fallback", {
      sessionId,
      persona: persona.id,
    });
  }
  const usage = usageFromMessage(completed);

  logger.info("Reviewer completed", {
    sessionId,
    persona: persona.id,
    score: parsed.score,
    issueCount: parsed.issues.length,
    tokens: usage.totalTokens,
  });

  return {
    sessionId,
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
  parts: MessagePart[],
  reviewerId: string,
): { score: number; issues: ReviewerOutput["issues"] } {
  const fallback = { score: 0.5, issues: [] as ReviewerOutput["issues"] };

  if (!Array.isArray(parts) || parts.length === 0) {
    logger.warn("Reviewer returned empty parts", { reviewerId });
    return fallback;
  }

  const text = extractTextFromParts(parts);
  if (!text) {
    logger.warn("Reviewer parts contained no text", { reviewerId });
    return fallback;
  }

  const raw = parseJsonFromText<Record<string, unknown>>(text);
  if (!raw) {
    logger.warn("Could not parse reviewer JSON", {
      reviewerId,
      textPreview: text.slice(0, 300),
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
