import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getQueueStats, getPendingMessages, drainQueue, compactQueue } from "../../src/message-queue.js";

function msgObj(overrides: Partial<{ id: string; from: string; to: string; message: string; priority: string; status: string; timestamp: string }> = {}) {
  return {
    id: overrides.id ?? "msg-1",
    from: overrides.from ?? "orchestrator",
    to: overrides.to ?? "agent-a",
    message: overrides.message ?? "hello",
    priority: overrides.priority ?? "normal",
    status: overrides.status ?? "pending",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
}

/** Write a message as a JSON file in the appropriate directory. */
async function writeMsg(messagesDir: string, agentId: string, status: "pending" | "read", overrides: Parameters<typeof msgObj>[0] = {}) {
  const msg = msgObj({ to: agentId, status, ...overrides });
  const dir = join(messagesDir, agentId, status);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${msg.id}.json`), JSON.stringify(msg));
  return msg;
}

describe("message-queue", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupDir() {
    tmpDir = await mkdtemp(join(tmpdir(), "mq-test-"));
    const messagesDir = join(tmpDir, "messages");
    await mkdir(messagesDir, { recursive: true });
    return messagesDir;
  }

  describe("getQueueStats", () => {
    it("returns correct counts with 2 agents and mixed pending/read", async () => {
      const messagesDir = await setupDir();

      await writeMsg(messagesDir, "agent-a", "pending", { id: "1" });
      await writeMsg(messagesDir, "agent-a", "read", { id: "2" });
      await writeMsg(messagesDir, "agent-a", "pending", { id: "3" });

      await writeMsg(messagesDir, "agent-b", "read", { id: "4" });
      await writeMsg(messagesDir, "agent-b", "read", { id: "5" });

      const stats = await getQueueStats(tmpDir);

      expect(stats.totalMessages).toBe(5);
      expect(stats.pendingMessages).toBe(2);
      expect(stats.readMessages).toBe(3);
      expect(stats.perAgent["agent-a"]).toEqual({ pending: 2, read: 1 });
      expect(stats.perAgent["agent-b"]).toEqual({ pending: 0, read: 2 });
    });

    it("counts urgent pending messages", async () => {
      const messagesDir = await setupDir();

      await writeMsg(messagesDir, "agent-x", "pending", { id: "1", priority: "urgent" });
      await writeMsg(messagesDir, "agent-x", "pending", { id: "2", priority: "normal" });
      await writeMsg(messagesDir, "agent-x", "pending", { id: "3", priority: "urgent" });
      await writeMsg(messagesDir, "agent-x", "read", { id: "4", priority: "urgent" });

      const stats = await getQueueStats(tmpDir);

      expect(stats.urgentPending).toBe(2);
      expect(stats.pendingMessages).toBe(3);
    });

    it("returns zeros when messages directory does not exist", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "mq-test-"));
      // Do NOT create messages/ subdir

      const stats = await getQueueStats(tmpDir);

      expect(stats.totalMessages).toBe(0);
      expect(stats.pendingMessages).toBe(0);
      expect(stats.readMessages).toBe(0);
      expect(stats.urgentPending).toBe(0);
      expect(stats.perAgent).toEqual({});
    });

    it("silently skips malformed JSON files", async () => {
      const messagesDir = await setupDir();

      await writeMsg(messagesDir, "agent-z", "pending", { id: "1" });
      await writeMsg(messagesDir, "agent-z", "read", { id: "2" });

      // Write a malformed file
      const pendingDir = join(messagesDir, "agent-z", "pending");
      await writeFile(join(pendingDir, "bad.json"), "THIS IS NOT JSON {{{");

      const stats = await getQueueStats(tmpDir);

      // Only the 2 valid messages should be counted (malformed pending still increments pending count but not urgent)
      expect(stats.totalMessages).toBe(3);
      expect(stats.pendingMessages).toBe(2);
      expect(stats.readMessages).toBe(1);
    });
  });

  describe("getPendingMessages", () => {
    it("returns only pending messages for the specific agent", async () => {
      const messagesDir = await setupDir();

      await writeMsg(messagesDir, "agent-a", "pending", { id: "1", message: "do stuff" });
      await writeMsg(messagesDir, "agent-a", "read", { id: "2", message: "old" });
      await writeMsg(messagesDir, "agent-a", "pending", { id: "3", message: "more stuff" });

      const pending = await getPendingMessages("agent-a", tmpDir);

      expect(pending).toHaveLength(2);
      expect(pending.map(m => m.id).sort()).toEqual(["1", "3"]);
    });

    it("returns empty array if agent directory does not exist", async () => {
      await setupDir();
      const pending = await getPendingMessages("nonexistent", tmpDir);
      expect(pending).toEqual([]);
    });
  });

  describe("drainQueue", () => {
    it("moves all pending messages to read and returns count", async () => {
      const messagesDir = await setupDir();

      await writeMsg(messagesDir, "agent-a", "pending", { id: "1" });
      await writeMsg(messagesDir, "agent-a", "read", { id: "2" });
      await writeMsg(messagesDir, "agent-a", "pending", { id: "3" });

      const drained = await drainQueue(tmpDir);

      expect(drained).toBe(2);

      // Verify files moved from pending/ to read/
      const pendingDir = join(messagesDir, "agent-a", "pending");
      const readDir = join(messagesDir, "agent-a", "read");
      const pendingFiles = (await readdir(pendingDir)).filter(f => f.endsWith(".json"));
      const readFiles = (await readdir(readDir)).filter(f => f.endsWith(".json"));

      expect(pendingFiles).toHaveLength(0);
      expect(readFiles).toHaveLength(3); // 2 moved + 1 already there
    });

    it("returns 0 when messages directory does not exist", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "mq-test-"));
      const drained = await drainQueue(tmpDir);
      expect(drained).toBe(0);
    });

    it("returns 0 when directory is empty", async () => {
      await setupDir();
      const drained = await drainQueue(tmpDir);
      expect(drained).toBe(0);
    });
  });

  describe("compactQueue", () => {
    it("deletes all files in read/ directories", async () => {
      const messagesDir = await setupDir();

      await writeMsg(messagesDir, "agent-a", "read", { id: "1" });
      await writeMsg(messagesDir, "agent-a", "read", { id: "2" });
      await writeMsg(messagesDir, "agent-a", "pending", { id: "3" });

      const deleted = await compactQueue(tmpDir);

      expect(deleted).toBe(2);

      // read/ should be empty, pending/ untouched
      const readDir = join(messagesDir, "agent-a", "read");
      const pendingDir = join(messagesDir, "agent-a", "pending");
      const readFiles = (await readdir(readDir)).filter(f => f.endsWith(".json"));
      const pendingFiles = (await readdir(pendingDir)).filter(f => f.endsWith(".json"));

      expect(readFiles).toHaveLength(0);
      expect(pendingFiles).toHaveLength(1);
    });

    it("returns 0 when messages directory does not exist", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "mq-test-"));
      const deleted = await compactQueue(tmpDir);
      expect(deleted).toBe(0);
    });
  });
});
