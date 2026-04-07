import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/beads.js", () => ({
  listTasks: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../src/mem0.js", () => ({
  searchAll: vi.fn().mockResolvedValue([]),
  formatMemoriesAsContext: vi.fn().mockReturnValue(""),
}));
vi.mock("../../src/usage-tracker.js", () => ({
  extractUsage: vi.fn().mockReturnValue({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  UsageAccumulator: vi.fn(),
}));

import { _extractPlannerOutput, _extractReviewOutput } from "../../src/agent-spawner.js";

// ---------------------------------------------------------------------------
// _extractPlannerOutput — now takes a parts array (MessagePart[])
// ---------------------------------------------------------------------------

describe("_extractPlannerOutput", () => {
  const validPlan = {
    summary: "Build a web app",
    tasks: [{ title: "Task 1", description: "Do stuff", suggested_persona: "frontend-dev", priority: 1 }],
  };

  it("parses direct JSON in a single TextPart", () => {
    const result = _extractPlannerOutput([{ type: "text", text: JSON.stringify(validPlan) }]);
    expect(result.summary).toBe("Build a web app");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe("Task 1");
  });

  it("parses JSON inside a fenced code block", () => {
    const text = "Here's the plan:\n\n```json\n" + JSON.stringify(validPlan) + "\n```\n\nThat's it.";
    const result = _extractPlannerOutput([{ type: "text", text }]);
    expect(result.summary).toBe("Build a web app");
    expect(result.tasks).toHaveLength(1);
  });

  it("concatenates multiple TextParts before parsing", () => {
    // Plan split across two text parts (rare but possible)
    const result = _extractPlannerOutput([
      { type: "text", text: '{"summary":"X",' },
      { type: "text", text: '"tasks":[]}' },
    ]);
    expect(result.summary).toBe("X");
    expect(result.tasks).toEqual([]);
  });

  it("ignores non-text parts (tool, file, etc.)", () => {
    const result = _extractPlannerOutput([
      { type: "tool", name: "read_file" },
      { type: "text", text: JSON.stringify(validPlan) },
      { type: "file", path: "/foo.ts" },
    ]);
    expect(result.tasks).toHaveLength(1);
  });

  it("returns empty plan for empty parts array", () => {
    const result = _extractPlannerOutput([]);
    expect(result.summary).toMatch(/Empty plan/i);
    expect(result.tasks).toEqual([]);
  });

  it("returns empty plan when parts contain no text", () => {
    const result = _extractPlannerOutput([{ type: "tool", name: "read_file" }]);
    expect(result.summary).toMatch(/no text|Empty plan/i);
    expect(result.tasks).toEqual([]);
  });

  it("returns empty plan for unparseable JSON", () => {
    const result = _extractPlannerOutput([{ type: "text", text: "this is not JSON at all" }]);
    expect(result.summary).toMatch(/Failed to parse/i);
    expect(result.tasks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// _extractReviewOutput — now takes a parts array (MessagePart[])
// ---------------------------------------------------------------------------

describe("_extractReviewOutput", () => {
  const validReview = {
    score: 0.9,
    issues: [{ severity: "high", description: "Missing error handling" }],
  };

  it("parses direct JSON in a TextPart", () => {
    const result = _extractReviewOutput(
      [{ type: "text", text: JSON.stringify(validReview) }],
      "reviewer-1",
    );
    expect(result.score).toBe(0.9);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].description).toBe("Missing error handling");
  });

  it("parses JSON inside a fenced code block", () => {
    const text = "## Review\n\n```json\n" + JSON.stringify(validReview) + "\n```";
    const result = _extractReviewOutput([{ type: "text", text }], "reviewer-1");
    expect(result.score).toBe(0.9);
    expect(result.issues).toHaveLength(1);
  });

  it("clamps score above 1 down to 1", () => {
    const result = _extractReviewOutput(
      [{ type: "text", text: JSON.stringify({ score: 1.5, issues: [] }) }],
      "reviewer-1",
    );
    expect(result.score).toBe(1);
  });

  it("clamps score below 0 up to 0", () => {
    const result = _extractReviewOutput(
      [{ type: "text", text: JSON.stringify({ score: -0.3, issues: [] }) }],
      "reviewer-1",
    );
    expect(result.score).toBe(0);
  });

  it("defaults non-numeric score to 0.5", () => {
    const result = _extractReviewOutput(
      [{ type: "text", text: JSON.stringify({ score: "high", issues: [] }) }],
      "reviewer-1",
    );
    expect(result.score).toBe(0.5);
  });

  it("returns fallback for empty parts array", () => {
    const result = _extractReviewOutput([], "reviewer-1");
    expect(result.score).toBe(0.5);
    expect(result.issues).toEqual([]);
  });

  it("returns fallback when parts contain no text", () => {
    const result = _extractReviewOutput([{ type: "tool", name: "read" }], "reviewer-1");
    expect(result.score).toBe(0.5);
    expect(result.issues).toEqual([]);
  });

  it("filters out issues missing required fields", () => {
    const review = {
      score: 0.7,
      issues: [
        { severity: "high", description: "Valid issue" },
        { severity: "low" }, // missing description
        { description: "Missing severity" }, // missing severity
        { severity: "medium", description: "Also valid" },
      ],
    };
    const result = _extractReviewOutput(
      [{ type: "text", text: JSON.stringify(review) }],
      "reviewer-1",
    );
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].description).toBe("Valid issue");
    expect(result.issues[1].description).toBe("Also valid");
  });

  it("ignores non-text parts when extracting", () => {
    const result = _extractReviewOutput(
      [
        { type: "file", path: "/x.ts" },
        { type: "text", text: JSON.stringify(validReview) },
      ],
      "reviewer-1",
    );
    expect(result.score).toBe(0.9);
  });
});
