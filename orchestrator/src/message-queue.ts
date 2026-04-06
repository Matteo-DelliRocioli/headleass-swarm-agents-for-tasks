// ---------------------------------------------------------------------------
// Message queue — orchestrator-side management of the file-based swarm queue
// ---------------------------------------------------------------------------
//
// Messages are stored as individual JSON files at:
//   {swarmStatePath}/messages/{agentId}/pending/{uuid}.json  — unread
//   {swarmStatePath}/messages/{agentId}/read/{uuid}.json     — acknowledged
//
// Each file contains a JSON message with: id, from, to, message, priority, status, timestamp
// Status transitions: pending → read (via renameSync for atomicity)
// ---------------------------------------------------------------------------

import { readdir, readFile, rename, mkdir, rm } from "node:fs/promises";
import { existsSync, mkdirSync, renameSync } from "node:fs";
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
    const agentDirs = await readdir(messagesDir);

    for (const agentId of agentDirs) {
      const agentPath = join(messagesDir, agentId);
      let pending = 0;
      let read = 0;

      // Count pending messages
      const pendingDir = join(agentPath, "pending");
      try {
        const pendingFiles = (await readdir(pendingDir)).filter(f => f.endsWith(".json"));
        for (const file of pendingFiles) {
          pending++;
          stats.pendingMessages++;
          stats.totalMessages++;
          try {
            const content = await readFile(join(pendingDir, file), "utf-8");
            const msg: QueueMessage = JSON.parse(content);
            if (msg.priority === "urgent") stats.urgentPending++;
          } catch {
            // Skip unreadable files
          }
        }
      } catch {
        // No pending directory
      }

      // Count read messages
      const readDir = join(agentPath, "read");
      try {
        const readFiles = (await readdir(readDir)).filter(f => f.endsWith(".json"));
        read = readFiles.length;
        stats.readMessages += read;
        stats.totalMessages += read;
      } catch {
        // No read directory
      }

      if (pending > 0 || read > 0) {
        stats.perAgent[agentId] = { pending, read };
      }
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
  const pendingDir = join(swarmStatePath, "messages", agentId, "pending");

  try {
    const files = (await readdir(pendingDir)).filter(f => f.endsWith(".json"));
    const messages: QueueMessage[] = [];

    for (const file of files) {
      try {
        const content = await readFile(join(pendingDir, file), "utf-8");
        messages.push(JSON.parse(content));
      } catch {
        // Skip malformed files
      }
    }

    return messages;
  } catch {
    return [];
  }
}

/**
 * Drain the queue — move all pending messages to read.
 * Used at end of run or between loops to clear the queue.
 */
export async function drainQueue(swarmStatePath: string): Promise<number> {
  const messagesDir = join(swarmStatePath, "messages");
  let drained = 0;

  try {
    const agentDirs = await readdir(messagesDir);

    for (const agentId of agentDirs) {
      const pendingDir = join(messagesDir, agentId, "pending");
      const readDir = join(messagesDir, agentId, "read");

      try {
        const files = (await readdir(pendingDir)).filter(f => f.endsWith(".json"));
        if (files.length === 0) continue;

        mkdirSync(readDir, { recursive: true });

        for (const file of files) {
          try {
            renameSync(join(pendingDir, file), join(readDir, file));
            drained++;
          } catch {
            // File may have already been moved
          }
        }
      } catch {
        // No pending directory for this agent
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

/**
 * Compact the queue — delete all files in read/ directories (cleanup old messages).
 */
export async function compactQueue(swarmStatePath: string): Promise<number> {
  const messagesDir = join(swarmStatePath, "messages");
  let deleted = 0;

  try {
    const agentDirs = await readdir(messagesDir);

    for (const agentId of agentDirs) {
      const readDir = join(messagesDir, agentId, "read");

      try {
        const files = (await readdir(readDir)).filter(f => f.endsWith(".json"));
        for (const file of files) {
          try {
            await rm(join(readDir, file));
            deleted++;
          } catch {
            // Skip files that can't be deleted
          }
        }
      } catch {
        // No read directory for this agent
      }
    }
  } catch {
    // Messages dir doesn't exist yet
  }

  if (deleted > 0) {
    logger.info("Queue compacted", { messagesDeleted: deleted });
  }

  return deleted;
}
