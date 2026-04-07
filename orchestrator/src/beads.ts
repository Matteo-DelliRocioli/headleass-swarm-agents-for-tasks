// ---------------------------------------------------------------------------
// Beads CLI wrapper for the in-pod orchestrator
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Phase F1: Subprocess concurrency limiter
// Prevents file-descriptor exhaustion when many agents call `bd` in parallel.
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_BD = 3;
let activeBdCalls = 0;
const waitQueue: Array<() => void> = [];

async function withBdLimit<T>(fn: () => Promise<T>): Promise<T> {
  while (activeBdCalls >= MAX_CONCURRENT_BD) {
    await new Promise<void>((resolve) => waitQueue.push(resolve));
  }
  activeBdCalls++;
  try {
    return await fn();
  } finally {
    activeBdCalls--;
    const next = waitQueue.shift();
    if (next) next();
  }
}

async function bd(args: string[]): Promise<string> {
  return withBdLimit(async () => {
    logger.debug("bd command", { args });
    const { stdout } = await execFileAsync("bd", args, {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  });
}

export interface BeadsTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  assignee?: string;
  description?: string;
  type?: string;  // "task" | "epic" | "bug" | etc.
}

export async function createEpic(title: string, description: string): Promise<string> {
  const output = await bd(["create", title, "-t", "epic", "-p", "1", "--description", description, "--json"]);
  const parsed = JSON.parse(output);
  return parsed.id ?? parsed.ID;
}

export async function createTask(
  title: string,
  parentId: string,
  options?: { priority?: number; description?: string },
): Promise<string> {
  const args = ["create", title, "-t", "task", "-p", String(options?.priority ?? 1), "--parent", parentId];
  if (options?.description) args.push("--description", options.description);
  args.push("--json");
  const output = await bd(args);
  const parsed = JSON.parse(output);
  return parsed.id ?? parsed.ID;
}

export async function addDependency(childId: string, parentId: string): Promise<void> {
  await bd(["dep", "add", childId, parentId]);
}

export async function claimTask(taskId: string): Promise<boolean> {
  try {
    await bd(["update", taskId, "--claim"]);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already claimed")) return true; // Our own claim from a previous cycle
    logger.warn("Failed to claim task", { taskId, error: msg });
    return false;
  }
}

export async function closeTask(taskId: string, reason?: string): Promise<void> {
  const args = ["close", taskId];
  if (reason) args.push("--reason", reason);
  await bd(args);
}

export async function getReadyTasks(): Promise<BeadsTask[]> {
  try {
    const output = await bd(["ready", "--json"]);
    const parsed = JSON.parse(output);
    const items = Array.isArray(parsed) ? parsed : parsed.issues ?? [];
    return items
      .map((item: Record<string, unknown>) => ({
        id: String(item.id ?? item.ID ?? ""),
        title: String(item.title ?? ""),
        status: String(item.status ?? "open"),
        priority: Number(item.priority ?? 2),
        assignee: item.assignee ? String(item.assignee) : undefined,
        description: item.description ? String(item.description) : undefined,
        type: item.issue_type ? String(item.issue_type) : (item.type ? String(item.type) : undefined),
      }))
      // Filter out epics — they're containers, not actionable work
      .filter((t: BeadsTask) => t.type !== "epic");
  } catch {
    return [];
  }
}

export async function listInProgress(): Promise<BeadsTask[]> {
  return listTasks("in_progress");
}

export async function unclaimTask(taskId: string): Promise<void> {
  await bd(["update", taskId, "--status=open"]);
}

export async function listTasks(status?: string): Promise<BeadsTask[]> {
  const args = ["list", "--json"];
  if (status) args.push("--status", status);
  try {
    const output = await bd(args);
    const parsed = JSON.parse(output);
    const items = Array.isArray(parsed) ? parsed : parsed.issues ?? [];
    return items.map((item: Record<string, unknown>) => ({
      id: String(item.id ?? item.ID ?? ""),
      title: String(item.title ?? ""),
      status: String(item.status ?? "open"),
      priority: Number(item.priority ?? 2),
      assignee: item.assignee ? String(item.assignee) : undefined,
      description: item.description ? String(item.description) : undefined,
    }));
  } catch {
    return [];
  }
}
