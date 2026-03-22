// ---------------------------------------------------------------------------
// Agent spawner — creates OpenCode sessions via SDK for each persona/task
// ---------------------------------------------------------------------------

import { logger } from "./logger.js";
import type { OrchestratorConfig } from "./config.js";
import type { Persona } from "./persona-loader.js";
import type { BeadsTask } from "./beads.js";
import { listTasks } from "./beads.js";

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
  // Dynamic import to handle SDK availability
  const { createOpencode } = await import("@opencode-ai/sdk");
  const { client } = await createOpencode({
    hostname: config.opencodeHost,
    port: config.opencodePort,
  });
  _client = client as unknown as OpenCodeClient;
  return _client;
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

  return `## Swarm Context

### Your Assignment
- **Task ID**: ${task.id}
- **Task**: ${task.title}
${task.description ? `- **Details**: ${task.description}` : ""}
- **Your Role**: ${persona.id} (${persona.description})

### Active Agents
${roster || "No other agents currently active."}

### Rules
- You MUST claim your task before starting: use the beads-claim tool with task ID "${task.id}"
- When finished, close your task: use the beads-close tool with task ID "${task.id}"
- Do NOT modify files in .claude/ directories
- If you need to communicate with another agent, use the swarm-send tool
- Check swarm-status to see file locks before editing shared files
- Write your key decisions to memory (Mem0) for other agents to reference

### Session Key
agent:${persona.id}:task:${task.id}
`;
}

export interface SpawnResult {
  sessionId: string;
  persona: Persona;
  task: BeadsTask;
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
    path: { id: session.id },
    body: {
      noReply: true,
      parts: [{ type: "text", text: context }],
    },
  });

  // Send the actual task prompt
  const [provider, model] = config.model.includes("/")
    ? config.model.split("/", 2)
    : ["anthropic", config.model];

  await client.session.prompt({
    path: { id: session.id },
    body: {
      model: { providerID: provider, modelID: model },
      parts: [{ type: "text", text: task.description ?? task.title }],
    },
  });

  logger.info("Agent spawned", { sessionId: session.id, persona: persona.id, task: task.id });
  return { sessionId: session.id, persona, task };
}

/**
 * Spawn a review agent (read-only).
 * Returns structured JSON output via format schema.
 */
export async function spawnReviewer(
  persona: Persona,
  loopNumber: number,
  config: OrchestratorConfig,
): Promise<{ sessionId: string; persona: Persona }> {
  const client = await getClient(config);
  const sessionTitle = `agent:${persona.id}:review:loop-${loopNumber}`;

  logger.info("Spawning reviewer", { persona: persona.id, loop: loopNumber });

  const session = await client.session.create({
    body: { title: sessionTitle },
  });

  // Inject review context
  await client.session.prompt({
    path: { id: session.id },
    body: {
      noReply: true,
      parts: [{
        type: "text",
        text: `## Review Context\n\nYou are reviewing loop ${loopNumber} of a swarm run.\nReview all changed files in /workspace and provide your assessment.\nOutput your review as JSON with score and issues array.`,
      }],
    },
  });

  // Request structured review output
  const [provider, model] = config.model.includes("/")
    ? config.model.split("/", 2)
    : ["anthropic", config.model];

  await client.session.prompt({
    path: { id: session.id },
    body: {
      model: { providerID: provider, modelID: model },
      parts: [{ type: "text", text: "Review all changes made in this workspace. Analyze code quality, security, and architecture. Output your structured review." }],
      format: {
        type: "json_schema",
        schema: {
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
        },
      },
    },
  });

  return { sessionId: session.id, persona };
}
