import { z } from "zod";
import { tool } from "@opencode-ai/plugin";

const MEM0_API_URL = process.env.MEM0_API_URL ?? "http://localhost:8080";
const AGENT_ID = process.env.SWARM_AGENT_ID ?? "unknown";
const RUN_NAME = process.env.SWARM_RUN_NAME ?? "local-run";

export default tool({
  description:
    'Search Mem0 for memories from this swarm run. Use scope "own" to see only your memories, or "all" to see memories from all agents in this run.',
  args: {
    query: z.string().describe("Natural language search query"),
    scope: z
      .string()
      .default("own")
      .describe('"own" = only your memories, "all" = all agents in this run'),
    limit: z
      .number()
      .default(10)
      .describe("Maximum number of results to return"),
  },
  async execute(args) {
    const scope = args.scope === "all" ? "all" : "own";
    const limit = Math.min(args.limit ?? 10, 50);

    try {
      // Build search payload — omit agent_id for cross-agent search
      const payload: Record<string, unknown> = {
        query: args.query,
        user_id: RUN_NAME,
        limit,
      };

      if (scope === "own") {
        payload.agent_id = AGENT_ID;
      }

      const response = await fetch(`${MEM0_API_URL}/v1/memories/search/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text();
        return JSON.stringify({
          success: false,
          error: `Mem0 API returned ${response.status}: ${body.slice(0, 200)}`,
        });
      }

      const results = await response.json();
      const memories = Array.isArray(results)
        ? results
        : results.results ?? results.memories ?? [];

      return JSON.stringify({
        success: true,
        scope,
        query: args.query,
        count: memories.length,
        memories: memories.map((m: any) => ({
          id: m.id ?? m.memory_id,
          content: m.memory ?? m.content ?? m.text,
          agent: m.agent_id ?? m.metadata?.agent ?? "unknown",
          category: m.metadata?.category,
          score: m.score ?? m.relevance,
          timestamp: m.metadata?.timestamp ?? m.created_at,
        })),
      });
    } catch (err: any) {
      return JSON.stringify({
        success: false,
        error: `Mem0 unavailable: ${err.message ?? String(err)}`,
        hint: "Is the Mem0 server running? Check MEM0_API_URL env var.",
      });
    }
  },
});
