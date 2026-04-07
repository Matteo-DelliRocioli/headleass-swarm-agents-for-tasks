import { z } from "zod";
import { tool } from "@opencode-ai/plugin";

const MEM0_API_URL = process.env.MEM0_API_URL ?? "http://localhost:8080";
const AGENT_ID = process.env.SWARM_AGENT_ID ?? "unknown";
const RUN_NAME = process.env.SWARM_RUN_NAME ?? "local-run";

export default tool({
  description:
    "Store a memory in Mem0 for this agent. Other agents and the orchestrator can search for it later. Use this to record key decisions, discoveries, blockers, or context that other agents might need.",
  args: {
    content: z
      .string()
      .describe("The memory content to store (a fact, decision, or observation)"),
    category: z
      .string()
      .default("context")
      .describe(
        'Optional category tag: "decision", "discovery", "blocker", "context", "handoff"'
      ),
  },
  async execute(args) {
    const category = args.category ?? "context";

    try {
      const response = await fetch(`${MEM0_API_URL}/v1/memories/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: `[${category}] ${args.content}`,
            },
          ],
          user_id: RUN_NAME,
          agent_id: AGENT_ID,
          metadata: {
            category,
            agent: AGENT_ID,
            run: RUN_NAME,
            timestamp: new Date().toISOString(),
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        return JSON.stringify({
          success: false,
          error: `Mem0 API returned ${response.status}: ${body.slice(0, 200)}`,
        });
      }

      const result = await response.json();

      return JSON.stringify({
        success: true,
        memoryId: result.id ?? result.memory_id ?? "stored",
        agent: AGENT_ID,
        category,
        content: args.content.slice(0, 100),
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
