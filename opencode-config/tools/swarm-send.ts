import { tool } from "@opencode-ai/plugin";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";

const MESSAGES_DIR = process.env.SWARM_STATE_PATH
  ? `${process.env.SWARM_STATE_PATH}/messages`
  : "/workspace/.swarm/messages";

export default tool({
  description:
    "Send a message to another agent in the swarm. Messages are stored as JSONL and can be read by the target agent using swarm-receive.",
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
      if (!existsSync(MESSAGES_DIR)) {
        await mkdir(MESSAGES_DIR, { recursive: true });
      }

      const entry = {
        id: randomUUID(),
        from: args.from,
        to: args.to,
        message: args.message,
        priority,
        status: "pending",
        timestamp: new Date().toISOString(),
      };

      const filePath = `${MESSAGES_DIR}/${args.to}.jsonl`;
      await writeFile(filePath, JSON.stringify(entry) + "\n", { flag: "a" });

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
