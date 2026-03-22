import { tool } from "@opencode-ai/plugin";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";

export default tool({
  description:
    "Send a message to another agent in the swarm. Appends a JSON line to the target agent's message file at /workspace/.swarm/messages/{targetAgent}.jsonl.",
  args: {
    from: {
      type: "string",
      description: "The sending agent's identifier",
    },
    to: {
      type: "string",
      description: "The target agent's identifier",
    },
    message: {
      type: "string",
      description: "The message content to send",
    },
    priority: {
      type: "string",
      description: 'Message priority: "normal" or "urgent"',
      default: "normal",
    },
  },
  async execute(args) {
    const priority = args.priority === "urgent" ? "urgent" : "normal";
    const messagesDir = "/workspace/.swarm/messages";

    try {
      if (!existsSync(messagesDir)) {
        await mkdir(messagesDir, { recursive: true });
      }

      const entry = {
        from: args.from,
        to: args.to,
        message: args.message,
        priority,
        timestamp: new Date().toISOString(),
      };

      const filePath = `${messagesDir}/${args.to}.jsonl`;
      await writeFile(filePath, JSON.stringify(entry) + "\n", { flag: "a" });

      return {
        success: true,
        delivered: filePath,
        entry,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message ?? String(err),
      };
    }
  },
});
