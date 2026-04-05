// ---------------------------------------------------------------------------
// Mem0 client for the orchestrator — cross-agent memory layer
// ---------------------------------------------------------------------------
//
// Scoping model:
//   user_id  = swarm run name (e.g., "swarm-run-abc123")
//   agent_id = persona ID (e.g., "frontend-dev", "backend-dev")
//   run_id   = loop number (e.g., "loop-1") — optional, for per-loop tracking
//
// Agents write to their own agent_id scope.
// The orchestrator reads ACROSS all agent scopes (omits agent_id filter).
// ---------------------------------------------------------------------------

import { logger } from "./logger.js";

export interface Mem0Config {
  apiUrl: string;
  runName: string;
}

export interface Mem0Memory {
  id: string;
  content: string;
  agentId: string;
  category?: string;
  score?: number;
  timestamp?: string;
}

async function mem0Fetch(
  config: Mem0Config,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = `${config.apiUrl}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Mem0 ${path} returned ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

function parseMemories(raw: unknown): Mem0Memory[] {
  const list = Array.isArray(raw)
    ? raw
    : (raw as Record<string, unknown>)?.results
      ?? (raw as Record<string, unknown>)?.memories
      ?? [];

  if (!Array.isArray(list)) return [];

  return list.map((m: Record<string, unknown>) => ({
    id: String(m.id ?? m.memory_id ?? ""),
    content: String(m.memory ?? m.content ?? m.text ?? ""),
    agentId: String(m.agent_id ?? (m.metadata as Record<string, unknown>)?.agent ?? "unknown"),
    category: (m.metadata as Record<string, unknown>)?.category as string | undefined,
    score: typeof m.score === "number" ? m.score : undefined,
    timestamp: String(
      (m.metadata as Record<string, unknown>)?.timestamp ?? m.created_at ?? "",
    ),
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store an orchestrator-level observation in Mem0.
 * Tagged with the orchestrator's own agent_id.
 */
export async function addMemory(
  content: string,
  agentId: string,
  config: Mem0Config,
  category = "orchestrator",
): Promise<string | null> {
  try {
    const result = await mem0Fetch(config, "/v1/memories/", {
      messages: [{ role: "user", content: `[${category}] ${content}` }],
      user_id: config.runName,
      agent_id: agentId,
      metadata: {
        category,
        agent: agentId,
        run: config.runName,
        timestamp: new Date().toISOString(),
      },
    }) as Record<string, unknown>;

    const id = String(result.id ?? result.memory_id ?? "stored");
    logger.debug("Mem0: stored memory", { agentId, category, id });
    return id;
  } catch (err) {
    logger.warn("Mem0: failed to store memory", { error: String(err) });
    return null;
  }
}

/**
 * Search all agent memories in this run (no agent_id filter).
 * Used by the orchestrator to gather cross-agent context.
 */
export async function searchAll(
  query: string,
  config: Mem0Config,
  limit = 20,
): Promise<Mem0Memory[]> {
  try {
    const raw = await mem0Fetch(config, "/v1/memories/search/", {
      query,
      user_id: config.runName,
      limit,
    });
    const memories = parseMemories(raw);
    logger.debug("Mem0: searchAll", { query: query.slice(0, 50), results: memories.length });
    return memories;
  } catch (err) {
    logger.warn("Mem0: searchAll failed", { error: String(err) });
    return [];
  }
}

/**
 * Search memories for a specific agent in this run.
 */
export async function searchAgent(
  query: string,
  agentId: string,
  config: Mem0Config,
  limit = 10,
): Promise<Mem0Memory[]> {
  try {
    const raw = await mem0Fetch(config, "/v1/memories/search/", {
      query,
      user_id: config.runName,
      agent_id: agentId,
      limit,
    });
    const memories = parseMemories(raw);
    logger.debug("Mem0: searchAgent", { agentId, query: query.slice(0, 50), results: memories.length });
    return memories;
  } catch (err) {
    logger.warn("Mem0: searchAgent failed", { error: String(err) });
    return [];
  }
}

/**
 * Get all memories for this run — used for end-of-run summary or review priming.
 * Calls GET endpoint with user_id filter.
 */
export async function getRunMemories(
  config: Mem0Config,
  limit = 100,
): Promise<Mem0Memory[]> {
  try {
    const url = `${config.apiUrl}/v1/memories/?user_id=${encodeURIComponent(config.runName)}&limit=${limit}`;
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GET /v1/memories/ returned ${response.status}: ${text.slice(0, 200)}`);
    }

    const raw = await response.json();
    const memories = parseMemories(raw);
    logger.debug("Mem0: getRunMemories", { count: memories.length });
    return memories;
  } catch (err) {
    logger.warn("Mem0: getRunMemories failed", { error: String(err) });
    return [];
  }
}

/**
 * Build a context string from memories for injecting into agent prompts.
 * Groups by agent and formats as readable text.
 */
export function formatMemoriesAsContext(memories: Mem0Memory[]): string {
  if (memories.length === 0) return "";

  const byAgent = new Map<string, Mem0Memory[]>();
  for (const m of memories) {
    const list = byAgent.get(m.agentId) ?? [];
    list.push(m);
    byAgent.set(m.agentId, list);
  }

  const sections: string[] = [];
  for (const [agent, mems] of byAgent) {
    const items = mems.map(m => `- ${m.content}`).join("\n");
    sections.push(`**${agent}**:\n${items}`);
  }

  return `### Shared Memory (from other agents)\n\n${sections.join("\n\n")}`;
}
