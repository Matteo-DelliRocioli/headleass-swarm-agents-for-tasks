// ---------------------------------------------------------------------------
// Message queue — orchestrator-side management of the file-based swarm queue
// ---------------------------------------------------------------------------
//
// Messages are stored as JSONL files at {swarmStatePath}/messages/{agentId}.jsonl
// Each line is a JSON message with: id, from, to, message, priority, status, timestamp
// Status transitions: pending → read
// ---------------------------------------------------------------------------

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./logger.js";

interface QueueMessage {
  id: string;
  from: string;
  to: string;
  message: string;
  priority: string;
  status: string;
  timestamp: string;
}

interface QueueStats {
  totalMessages: number;
  pendingMessages: number;
  readMessages: number;
  perAgent: Record<string, { pending: number; read: number }>;
  urgentPending: number;
}

/**
 * Get queue statistics for the swarm run.
 */
export async function getQueueStats(swarmStatePath: string): Promise<QueueStats> {
  const messagesDir = join(swarmStatePath, "messages");
  const stats: QueueStats = {
    totalMessages: 0,
    pendingMessages: 0,
    readMessages: 0,
    perAgent: {},
    urgentPending: 0,
  };

  try {
    const files = await readdir(messagesDir);
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));

    for (const file of jsonlFiles) {
      const agentId = file.replace(".jsonl", "");
      const content = await readFile(join(messagesDir, file), "utf-8");
      const messages = parseMessages(content);

      let pending = 0;
      let read = 0;
      for (const m of messages) {
        stats.totalMessages++;
        if (m.status === "pending") {
          pending++;
          stats.pendingMessages++;
          if (m.priority === "urgent") stats.urgentPending++;
        } else {
          read++;
          stats.readMessages++;
        }
      }

      stats.perAgent[agentId] = { pending, read };
    }
  } catch {
    // Messages dir doesn't exist yet — empty queue
  }

  return stats;
}

/**
 * Get all pending messages for a specific agent.
 */
export async function getPendingMessages(
  agentId: string,
  swarmStatePath: string,
): Promise<QueueMessage[]> {
  const filePath = join(swarmStatePath, "messages", `${agentId}.jsonl`);

  try {
    const content = await readFile(filePath, "utf-8");
    return parseMessages(content).filter(m => m.status === "pending");
  } catch {
    return [];
  }
}

/**
 * Drain the queue — mark all pending messages as read.
 * Used at end of run or between loops to clear the queue.
 */
export async function drainQueue(swarmStatePath: string): Promise<number> {
  const messagesDir = join(swarmStatePath, "messages");
  let drained = 0;

  try {
    const files = await readdir(messagesDir);
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));

    for (const file of jsonlFiles) {
      const filePath = join(messagesDir, file);
      const content = await readFile(filePath, "utf-8");
      const messages = parseMessages(content);

      let changed = false;
      for (const m of messages) {
        if (m.status === "pending") {
          m.status = "read";
          changed = true;
          drained++;
        }
      }

      if (changed) {
        await writeFile(filePath, messages.map(m => JSON.stringify(m)).join("\n") + "\n");
      }
    }
  } catch {
    // Messages dir doesn't exist yet
  }

  if (drained > 0) {
    logger.info("Queue drained", { messagesMarkedRead: drained });
  }

  return drained;
}

function parseMessages(content: string): QueueMessage[] {
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as QueueMessage;
      } catch {
        return null;
      }
    })
    .filter((m): m is QueueMessage => m !== null);
}
