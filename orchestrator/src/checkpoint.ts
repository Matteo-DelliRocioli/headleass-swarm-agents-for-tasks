// ---------------------------------------------------------------------------
// Checkpoint — persists orchestrator state for crash recovery
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";

export interface Checkpoint {
  version: 1;
  runName: string;

  // Phase 1 state
  epicId: string;
  planCompleted: boolean;
  taskPersonaMap: Record<string, string>; // taskId → suggestedPersona

  // Main loop state
  currentLoop: number;
  totalTasks: number;
  completedTasks: number;

  // Per-task tracking
  completedTaskIds: string[];
  failedTaskIds: string[];

  // Accumulator state
  usage: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number }>;
  errors: string[];
  loopDurations: number[];

  // Git state
  lastCommitSha: string;

  // Timestamp
  lastUpdatedAt: string;
}

const CHECKPOINT_FILE = "checkpoint.json";
const CHECKPOINT_TMP = ".checkpoint.tmp";

export function createCheckpoint(runName: string): Checkpoint {
  return {
    version: 1,
    runName,
    epicId: "",
    planCompleted: false,
    taskPersonaMap: {},
    currentLoop: 0,
    totalTasks: 0,
    completedTasks: 0,
    completedTaskIds: [],
    failedTaskIds: [],
    usage: {},
    errors: [],
    loopDurations: [],
    lastCommitSha: "",
    lastUpdatedAt: new Date().toISOString(),
  };
}

/**
 * Load checkpoint from disk. Returns null if missing, corrupt, or wrong version.
 */
export function loadCheckpoint(swarmStatePath: string): Checkpoint | null {
  const filePath = join(swarmStatePath, CHECKPOINT_FILE);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as Checkpoint;
    if (data.version !== 1) {
      logger.warn("Checkpoint version mismatch", { found: data.version, expected: 1 });
      return null;
    }
    logger.info("Checkpoint loaded", {
      runName: data.runName,
      currentLoop: data.currentLoop,
      completedTasks: data.completedTasks,
      planCompleted: data.planCompleted,
    });
    return data;
  } catch {
    return null;
  }
}

/**
 * Save checkpoint atomically via write-to-tmp + rename.
 */
export function saveCheckpoint(swarmStatePath: string, checkpoint: Checkpoint): void {
  mkdirSync(swarmStatePath, { recursive: true });
  checkpoint.lastUpdatedAt = new Date().toISOString();
  const filePath = join(swarmStatePath, CHECKPOINT_FILE);
  const tmpPath = join(swarmStatePath, CHECKPOINT_TMP);
  try {
    writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    logger.warn("Failed to save checkpoint", { error: String(err) });
  }
}

/**
 * Merge a partial update into the existing checkpoint and save.
 */
export function updateCheckpoint(
  swarmStatePath: string,
  checkpoint: Checkpoint,
  patch: Partial<Checkpoint>,
): void {
  Object.assign(checkpoint, patch);
  saveCheckpoint(swarmStatePath, checkpoint);
}
