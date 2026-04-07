import { z } from "zod";
import { tool } from "@opencode-ai/plugin";
import { readFile, readdir, rename } from "fs/promises";
import { existsSync, mkdirSync } from "fs";

const MESSAGES_DIR = process.env.SWARM_STATE_PATH
  ? `${process.env.SWARM_STATE_PATH}/messages`
  : "/workspace/.swarm/messages";

const AGENT_ID = process.env.SWARM_AGENT_ID ?? "unknown";

interface Message {
  id: string;
  from: string;
  to: string;
  message: string;
  priority: string;
  status: string;
  timestamp: string;
}

export default tool({
  description:
    "Read pending messages for the current agent. Returns unread messages and optionally moves them to the read directory. Use this to check if other agents have sent you handoff requests, blockers, or context.",
  args: {
    acknowledge: z
      .boolean()
      .default(true)
      .describe("If true, mark returned messages as read (default: true)"),
    filter_priority: z
      .string()
      .default("all")
      .describe('Only return messages with this priority: "urgent", "normal", or "all"'),
  },
  async execute(args) {
    const ack = args.acknowledge !== false;
    const filterPriority = args.filter_priority ?? "all";
    const pendingDir = `${MESSAGES_DIR}/${AGENT_ID}/pending`;

    try {
      if (!existsSync(pendingDir)) {
        return JSON.stringify({
          success: true,
          agent: AGENT_ID,
          count: 0,
          messages: [],
        });
      }

      const files = (await readdir(pendingDir)).filter(f => f.endsWith(".json"));

      if (files.length === 0) {
        return JSON.stringify({
          success: true,
          agent: AGENT_ID,
          count: 0,
          messages: [],
        });
      }

      const allMessages: Message[] = [];
      for (const file of files) {
        try {
          const content = await readFile(`${pendingDir}/${file}`, "utf-8");
          allMessages.push(JSON.parse(content));
        } catch {
          // Skip malformed files
        }
      }

      // Apply priority filter
      let pending = filterPriority === "all"
        ? allMessages
        : allMessages.filter(m => m.priority === filterPriority);

      if (pending.length === 0) {
        return JSON.stringify({
          success: true,
          agent: AGENT_ID,
          count: 0,
          messages: [],
        });
      }

      // Move to read/ directory if acknowledging
      if (ack) {
        const readDir = `${MESSAGES_DIR}/${AGENT_ID}/read`;
        mkdirSync(readDir, { recursive: true });

        for (const m of pending) {
          const srcPath = `${pendingDir}/${m.id}.json`;
          const destPath = `${readDir}/${m.id}.json`;
          try {
            await rename(srcPath, destPath);
          } catch {
            // File may already have been moved by another reader
          }
        }
      }

      return JSON.stringify({
        success: true,
        agent: AGENT_ID,
        count: pending.length,
        messages: pending.map((m) => ({
          id: m.id,
          from: m.from,
          message: m.message,
          priority: m.priority,
          timestamp: m.timestamp,
        })),
      });
    } catch (err: any) {
      return JSON.stringify({
        success: false,
        error: err.message ?? String(err),
      });
    }
  },
});
