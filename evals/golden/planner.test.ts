/**
 * Planner Golden Test (Tier 3)
 *
 * Structural validation of planner output format and constraints.
 * Uses mock fixtures from evals/fixtures/mock-responses/ to verify the
 * validation logic itself is correct. The real LLM-backed version requires
 * GOLDEN_TEST=1 + a running OpenCode server.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const GOLDEN = process.env.GOLDEN_TEST === "1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PlannerTask {
  title: string;
  description: string;
  suggested_persona: string;
  priority: number;
  depends_on: string[];
}

interface PlannerOutput {
  summary: string;
  tasks: PlannerTask[];
}

function loadMockPlannerOutput(): PlannerOutput {
  const raw = readFileSync(
    resolve(__dirname, "../fixtures/mock-responses/planner-output.json"),
    "utf-8",
  );
  return JSON.parse(raw);
}

/**
 * Detect circular dependencies using DFS.
 * Returns true if a cycle exists.
 */
function hasCyclicDependencies(tasks: PlannerTask[]): boolean {
  const titleSet = new Set(tasks.map((t) => t.title));
  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    adj.set(t.title, t.depends_on.filter((d) => titleSet.has(d)));
  }

  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tasks) color.set(t.title, WHITE);

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const neighbor of adj.get(node) ?? []) {
      const c = color.get(neighbor);
      if (c === GRAY) return true; // back edge → cycle
      if (c === WHITE && dfs(neighbor)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const t of tasks) {
    if (color.get(t.title) === WHITE && dfs(t.title)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!GOLDEN)("Planner Golden Test", () => {
  const output = loadMockPlannerOutput();

  it(
    "summary is non-empty",
    () => {
      expect(output.summary).toBeTruthy();
      expect(output.summary.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    "tasks count is between 3 and 12",
    () => {
      expect(output.tasks.length).toBeGreaterThanOrEqual(3);
      expect(output.tasks.length).toBeLessThanOrEqual(12);
    },
    120_000,
  );

  it(
    "at least one task suggests a frontend persona",
    () => {
      const match = output.tasks.some(
        (t) =>
          t.suggested_persona.toLowerCase().includes("frontend") ||
          t.suggested_persona === "frontend-dev",
      );
      expect(match).toBe(true);
    },
    120_000,
  );

  it(
    "at least one task suggests a backend persona",
    () => {
      const match = output.tasks.some(
        (t) =>
          t.suggested_persona.toLowerCase().includes("backend") ||
          t.suggested_persona === "backend-dev",
      );
      expect(match).toBe(true);
    },
    120_000,
  );

  it(
    "at least one task suggests a database persona",
    () => {
      const match = output.tasks.some(
        (t) =>
          t.suggested_persona.toLowerCase().includes("database") ||
          t.suggested_persona === "database-specialist",
      );
      expect(match).toBe(true);
    },
    120_000,
  );

  it(
    "no circular dependencies in task graph",
    () => {
      expect(hasCyclicDependencies(output.tasks)).toBe(false);
    },
    120_000,
  );

  it(
    "all tasks have non-empty title and description",
    () => {
      for (const task of output.tasks) {
        expect(task.title).toBeTruthy();
        expect(task.title.length).toBeGreaterThan(0);
        expect(task.description).toBeTruthy();
        expect(task.description.length).toBeGreaterThan(0);
      }
    },
    120_000,
  );
});
