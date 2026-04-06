/**
 * Planner Golden Test (Tier 3)
 *
 * Two modes:
 *   1. Structural validation (always runs) — loads mock fixtures and validates
 *      the JSON structure and constraint-checking logic.
 *   2. LLM validation (GOLDEN_TEST=1 + OpenCode server) — sends a real prompt
 *      to the planner persona via OpenCode and validates the live output.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const GOLDEN = process.env.GOLDEN_TEST === "1";
const OPENCODE_URL =
  process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";

// ---------------------------------------------------------------------------
// Types & helpers
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
      if (c === GRAY) return true; // back edge -> cycle
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

/** Shared assertions applied to both mock and LLM outputs. */
function assertPlannerOutput(output: PlannerOutput) {
  // summary is non-empty
  expect(output.summary).toBeTruthy();
  expect(output.summary.length).toBeGreaterThan(0);

  // task count 3-12
  expect(output.tasks.length).toBeGreaterThanOrEqual(3);
  expect(output.tasks.length).toBeLessThanOrEqual(12);

  // frontend persona
  const hasFrontend = output.tasks.some(
    (t) =>
      t.suggested_persona.toLowerCase().includes("frontend") ||
      t.suggested_persona === "frontend-dev",
  );
  expect(hasFrontend).toBe(true);

  // backend persona
  const hasBackend = output.tasks.some(
    (t) =>
      t.suggested_persona.toLowerCase().includes("backend") ||
      t.suggested_persona === "backend-dev",
  );
  expect(hasBackend).toBe(true);

  // database persona
  const hasDatabase = output.tasks.some(
    (t) =>
      t.suggested_persona.toLowerCase().includes("database") ||
      t.suggested_persona === "database-specialist",
  );
  expect(hasDatabase).toBe(true);

  // no circular deps
  expect(hasCyclicDependencies(output.tasks)).toBe(false);

  // all tasks have non-empty title and description
  for (const task of output.tasks) {
    expect(task.title).toBeTruthy();
    expect(task.title.length).toBeGreaterThan(0);
    expect(task.description).toBeTruthy();
    expect(task.description.length).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// 1. Structural validation (always runs)
// ---------------------------------------------------------------------------

describe("Planner Structural Validation", () => {
  const output = loadMockPlannerOutput();

  it("summary is non-empty", () => {
    expect(output.summary).toBeTruthy();
    expect(output.summary.length).toBeGreaterThan(0);
  });

  it("tasks count is between 3 and 12", () => {
    expect(output.tasks.length).toBeGreaterThanOrEqual(3);
    expect(output.tasks.length).toBeLessThanOrEqual(12);
  });

  it("at least one task suggests a frontend persona", () => {
    const match = output.tasks.some(
      (t) =>
        t.suggested_persona.toLowerCase().includes("frontend") ||
        t.suggested_persona === "frontend-dev",
    );
    expect(match).toBe(true);
  });

  it("at least one task suggests a backend persona", () => {
    const match = output.tasks.some(
      (t) =>
        t.suggested_persona.toLowerCase().includes("backend") ||
        t.suggested_persona === "backend-dev",
    );
    expect(match).toBe(true);
  });

  it("at least one task suggests a database persona", () => {
    const match = output.tasks.some(
      (t) =>
        t.suggested_persona.toLowerCase().includes("database") ||
        t.suggested_persona === "database-specialist",
    );
    expect(match).toBe(true);
  });

  it("no circular dependencies in task graph", () => {
    expect(hasCyclicDependencies(output.tasks)).toBe(false);
  });

  it("all tasks have non-empty title and description", () => {
    for (const task of output.tasks) {
      expect(task.title).toBeTruthy();
      expect(task.title.length).toBeGreaterThan(0);
      expect(task.description).toBeTruthy();
      expect(task.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. LLM validation (gated behind GOLDEN_TEST=1)
// ---------------------------------------------------------------------------

describe.skipIf(!GOLDEN)("Planner LLM Validation", () => {
  let client: any;
  let serverAvailable = false;

  beforeAll(async () => {
    try {
      const resp = await fetch(OPENCODE_URL, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok && resp.status !== 404) {
        throw new Error(`Server returned ${resp.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `\nSkipping LLM planner tests: OpenCode server not reachable at ${OPENCODE_URL}`,
      );
      console.log(`Error: ${msg}\n`);
      return;
    }

    const { createOpencodeClient } = await import("@opencode-ai/sdk");
    client = createOpencodeClient({ baseUrl: OPENCODE_URL });
    serverAvailable = true;
  });

  it(
    "produces valid plan for Instagram clone prompt",
    async () => {
      if (!serverAvailable) return;

      const personaPrompt = readFileSync(
        resolve(__dirname, "../../personas/planner-agent.md"),
        "utf-8",
      );

      const session = await client.session.create({
        body: { title: "golden-planner-eval" },
      });
      const sessionId = session.id ?? session.data?.id;

      // Inject persona as system context
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          noReply: true,
          parts: [
            {
              type: "text",
              text: `You are the planner agent. Follow these instructions:\n\n${personaPrompt}`,
            },
          ],
        },
      });

      // Send the actual prompt
      const response = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [
            {
              type: "text",
              text: "Build an Instagram clone with user registration, photo upload, feed, likes, comments, and follow system",
            },
          ],
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                tasks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      description: { type: "string" },
                      suggested_persona: { type: "string" },
                      priority: { type: "number" },
                      depends_on: {
                        type: "array",
                        items: { type: "string" },
                      },
                    },
                    required: [
                      "title",
                      "description",
                      "suggested_persona",
                      "priority",
                      "depends_on",
                    ],
                  },
                },
              },
              required: ["summary", "tasks"],
            },
          },
        },
      });

      // Parse structured output
      const res = response as Record<string, unknown>;
      let parsed: PlannerOutput | undefined;

      if (typeof res.content === "string") {
        try {
          parsed = JSON.parse(res.content);
        } catch {
          /* */
        }
      }
      if (!parsed && Array.isArray(res.parts)) {
        for (const part of res.parts as Array<Record<string, unknown>>) {
          if (typeof part.text === "string") {
            try {
              parsed = JSON.parse(part.text);
              break;
            } catch {
              /* */
            }
          }
        }
      }
      if (!parsed && typeof res.summary === "string") {
        parsed = res as unknown as PlannerOutput;
      }

      expect(parsed).toBeDefined();
      assertPlannerOutput(parsed!);
    },
    120_000,
  );
});
