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
    from: {
      type: "string",
      description: "The sending agent's identifier (your SWARM_AGENT_ID)",
    },
    to: {
      type: "string",
      description: "The target agent's identifier (e.g., backend-dev, frontend-dev)",
    },
    message: {
      type: "string",
      description: "The message content to send",
    },
    priority: {
      type: "string",
      description: '"normal" or "urgent"',
      default: "normal",
    },
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

      return {
        success: true,
        messageId: entry.id,
        delivered: filePath,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message ?? String(err),
      };
    }
  },
});
