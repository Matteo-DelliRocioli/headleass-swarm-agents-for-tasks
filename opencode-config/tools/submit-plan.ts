import { z } from "zod";
import { tool } from "@opencode-ai/plugin";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

const SwarmStatePath = process.env.SWARM_STATE_PATH ?? "/workspace/.swarm";

/**
 * submit_plan — called by the planner agent to submit its task decomposition.
 *
 * The args ARE the structured plan output. Zod validates the shape at the
 * tool boundary, so the LLM physically cannot fail to produce valid JSON.
 *
 * The plan is written to /workspace/.swarm/plans/{sessionID}.json. The
 * orchestrator reads this file after session.idle, bypassing message parsing
 * entirely.
 */
export default tool({
  description:
    "Submit your task decomposition plan. Call this as your FINAL action — do not also output JSON in your message. The args ARE the plan; the orchestrator will read them directly.",
  args: {
    summary: z
      .string()
      .describe("One-line description of the overall plan"),
    tasks: z
      .array(
        z.object({
          title: z.string().describe("Short task title (max 80 chars)"),
          description: z
            .string()
            .describe("What needs to be done and why (1-3 sentences)"),
          suggested_persona: z
            .string()
            .describe(
              "Persona id: frontend-dev, backend-dev, database-specialist, devops-agent, test-writer",
            ),
          priority: z
            .number()
            .int()
            .min(0)
            .max(4)
            .describe("0=critical, 1=core, 2=secondary, 3=nice-to-have, 4=backlog"),
          depends_on: z
            .array(z.string())
            .optional()
            .describe("Titles of tasks this depends on (empty for independent tasks)"),
        }),
      )
      .min(1)
      .max(12)
      .describe("Between 1 and 12 atomic tasks"),
  },
  async execute(args, context) {
    const filePath = `${SwarmStatePath}/plans/${context.sessionID}.json`;

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({ summary: args.summary, tasks: args.tasks }, null, 2),
      );
      return JSON.stringify({
        success: true,
        message: `Plan submitted with ${args.tasks.length} tasks. Stop now.`,
        path: filePath,
      });
    } catch (err: any) {
      return JSON.stringify({
        success: false,
        error: err.message ?? String(err),
      });
    }
  },
});
