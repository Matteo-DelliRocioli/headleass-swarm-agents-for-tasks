import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getQueueStats, getPendingMessages, drainQueue } from "../../src/message-queue.js";

function msg(overrides: Partial<{ id: string; from: string; to: string; message: string; priority: string; status: string; timestamp: string }> = {}) {
  return JSON.stringify({
    id: overrides.id ?? "msg-1",
    from: overrides.from ?? "orchestrator",
    to: overrides.to ?? "agent-a",
    message: overrides.message ?? "hello",
    priority: overrides.priority ?? "normal",
    status: overrides.status ?? "pending",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  });
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

      const agentALines = [
        msg({ id: "1", to: "agent-a", status: "pending" }),
        msg({ id: "2", to: "agent-a", status: "read" }),
        msg({ id: "3", to: "agent-a", status: "pending" }),
      ].join("\n") + "\n";

      const agentBLines = [
        msg({ id: "4", to: "agent-b", status: "read" }),
        msg({ id: "5", to: "agent-b", status: "read" }),
      ].join("\n") + "\n";

      await writeFile(join(messagesDir, "agent-a.jsonl"), agentALines);
      await writeFile(join(messagesDir, "agent-b.jsonl"), agentBLines);

      const stats = await getQueueStats(tmpDir);

      expect(stats.totalMessages).toBe(5);
      expect(stats.pendingMessages).toBe(2);
      expect(stats.readMessages).toBe(3);
      expect(stats.perAgent["agent-a"]).toEqual({ pending: 2, read: 1 });
      expect(stats.perAgent["agent-b"]).toEqual({ pending: 0, read: 2 });
    });

    it("counts urgent pending messages", async () => {
      const messagesDir = await setupDir();

      const lines = [
        msg({ id: "1", status: "pending", priority: "urgent" }),
        msg({ id: "2", status: "pending", priority: "normal" }),
        msg({ id: "3", status: "pending", priority: "urgent" }),
        msg({ id: "4", status: "read", priority: "urgent" }),
      ].join("\n") + "\n";

      await writeFile(join(messagesDir, "agent-x.jsonl"), lines);

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

    it("silently skips malformed JSONL lines", async () => {
      const messagesDir = await setupDir();

      const lines = [
        msg({ id: "1", status: "pending" }),
        "THIS IS NOT JSON {{{",
        msg({ id: "2", status: "read" }),
        "",
        "also broken",
      ].join("\n") + "\n";

      await writeFile(join(messagesDir, "agent-z.jsonl"), lines);

      const stats = await getQueueStats(tmpDir);

      expect(stats.totalMessages).toBe(2);
      expect(stats.pendingMessages).toBe(1);
      expect(stats.readMessages).toBe(1);
    });
  });

  describe("getPendingMessages", () => {
    it("returns only pending messages for the specific agent", async () => {
      const messagesDir = await setupDir();

      const lines = [
        msg({ id: "1", from: "orchestrator", to: "agent-a", status: "pending", message: "do stuff" }),
        msg({ id: "2", from: "orchestrator", to: "agent-a", status: "read", message: "old" }),
        msg({ id: "3", from: "orchestrator", to: "agent-a", status: "pending", message: "more stuff" }),
      ].join("\n") + "\n";

      await writeFile(join(messagesDir, "agent-a.jsonl"), lines);

      const pending = await getPendingMessages("agent-a", tmpDir);

      expect(pending).toHaveLength(2);
      expect(pending.every(m => m.status === "pending")).toBe(true);
      expect(pending.map(m => m.id)).toEqual(["1", "3"]);
    });

    it("returns empty array if agent file does not exist", async () => {
      await setupDir();
      const pending = await getPendingMessages("nonexistent", tmpDir);
      expect(pending).toEqual([]);
    });
  });

  describe("drainQueue", () => {
    it("marks all pending messages as read and returns count", async () => {
      const messagesDir = await setupDir();

      const lines = [
        msg({ id: "1", status: "pending" }),
        msg({ id: "2", status: "read" }),
        msg({ id: "3", status: "pending" }),
      ].join("\n") + "\n";

      await writeFile(join(messagesDir, "agent-a.jsonl"), lines);

      const drained = await drainQueue(tmpDir);

      expect(drained).toBe(2);

      // Verify file was rewritten
      const content = await readFile(join(messagesDir, "agent-a.jsonl"), "utf-8");
      const rewritten = content.trim().split("\n").map(l => JSON.parse(l));
      expect(rewritten.every(m => m.status === "read")).toBe(true);
      expect(rewritten).toHaveLength(3);
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
});
