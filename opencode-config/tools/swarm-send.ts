import { z } from "zod";
import { tool } from "@opencode-ai/plugin";
import { writeFile, mkdir } from "fs/promises";
import { randomUUID } from "crypto";

const MESSAGES_DIR = process.env.SWARM_STATE_PATH
  ? `${process.env.SWARM_STATE_PATH}/messages`
  : "/workspace/.swarm/messages";

export default tool({
  description:
    "Send a message to another agent in the swarm. Messages are stored as individual JSON files and can be read by the target agent using swarm-receive.",
  args: {
    from: z.string().describe("The sending agent's identifier (your SWARM_AGENT_ID)"),
    to: z
      .string()
      .describe("The target agent's identifier (e.g., backend-dev, frontend-dev)"),
    message: z.string().describe("The message content to send"),
    priority: z.string().default("normal").describe('"normal" or "urgent"'),
  },
  async execute(args) {
    const priority = args.priority === "urgent" ? "urgent" : "normal";

    try {
      const pendingDir = `${MESSAGES_DIR}/${args.to}/pending`;
      await mkdir(pendingDir, { recursive: true });

      const id = randomUUID();
      const entry = {
        id,
        from: args.from,
        to: args.to,
        message: args.message,
        priority,
        status: "pending",
        timestamp: new Date().toISOString(),
      };

      const filePath = `${pendingDir}/${id}.json`;
      await writeFile(filePath, JSON.stringify(entry, null, 2));

      return JSON.stringify({
        success: true,
        messageId: entry.id,
        delivered: filePath,
      });
    } catch (err: any) {
      return JSON.stringify({
        success: false,
        error: err.message ?? String(err),
      });
    }
  },
});
