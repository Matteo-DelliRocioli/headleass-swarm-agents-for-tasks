import { tool } from "@opencode-ai/plugin";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

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
    "Read pending messages for the current agent. Returns unread messages and marks them as read. Use this to check if other agents have sent you handoff requests, blockers, or context.",
  args: {
    acknowledge: {
      type: "boolean",
      description: "If true, mark returned messages as read (default: true)",
      default: true,
    },
    filter_priority: {
      type: "string",
      description: 'Only return messages with this priority: "urgent", "normal", or "all"',
      default: "all",
    },
  },
  async execute(args) {
    const ack = args.acknowledge !== false;
    const filterPriority = args.filter_priority ?? "all";
    const filePath = `${MESSAGES_DIR}/${AGENT_ID}.jsonl`;

    try {
      if (!existsSync(filePath)) {
        return {
          success: true,
          agent: AGENT_ID,
          count: 0,
          messages: [],
        };
      }

      const raw = await readFile(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const allMessages: Message[] = lines.map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter((m): m is Message => m !== null);

      // Filter to pending messages
      let pending = allMessages.filter((m) => m.status === "pending");

      if (filterPriority !== "all") {
        pending = pending.filter((m) => m.priority === filterPriority);
      }

      if (pending.length === 0) {
        return {
          success: true,
          agent: AGENT_ID,
          count: 0,
          messages: [],
        };
      }

      // Mark as read if acknowledging
      if (ack) {
        const readIds = new Set(pending.map((m) => m.id));
        const updated = allMessages.map((m) =>
          readIds.has(m.id) ? { ...m, status: "read" } : m
        );
        await writeFile(
          filePath,
          updated.map((m) => JSON.stringify(m)).join("\n") + "\n"
        );
      }

      return {
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
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message ?? String(err),
      };
    }
  },
});
