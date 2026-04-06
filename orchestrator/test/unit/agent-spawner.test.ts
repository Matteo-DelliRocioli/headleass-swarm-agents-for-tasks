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
// _extractPlannerOutput
// ---------------------------------------------------------------------------

describe("_extractPlannerOutput", () => {
  const validPlan = { summary: "Build a web app", tasks: [{ title: "Task 1", description: "Do stuff", suggested_persona: "frontend-dev", priority: 1 }] };

  it("parses Shape 1: JSON string in content field", () => {
    const result = _extractPlannerOutput({ content: JSON.stringify(validPlan) });
    expect(result.summary).toBe("Build a web app");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe("Task 1");
  });

  it("parses Shape 2: parts array with text", () => {
    const result = _extractPlannerOutput({ parts: [{ text: JSON.stringify(validPlan) }] });
    expect(result.summary).toBe("Build a web app");
    expect(result.tasks).toHaveLength(1);
  });

  it("parses Shape 3: result object already parsed", () => {
    const result = _extractPlannerOutput({ result: { ...validPlan } });
    expect(result.summary).toBe("Build a web app");
    expect(result.tasks).toHaveLength(1);
  });

  it("parses Shape 4: direct object with tasks", () => {
    const result = _extractPlannerOutput({ ...validPlan });
    expect(result.summary).toBe("Build a web app");
    expect(result.tasks).toHaveLength(1);
  });

  it("returns empty plan for null response", () => {
    const result = _extractPlannerOutput(null);
    expect(result.summary).toMatch(/Empty plan/i);
    expect(result.tasks).toEqual([]);
  });

  it("returns empty plan for unparseable response", () => {
    const result = _extractPlannerOutput({ content: "not valid json {{{" });
    expect(result.summary).toMatch(/Failed to parse/i);
    expect(result.tasks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// _extractReviewOutput
// ---------------------------------------------------------------------------

describe("_extractReviewOutput", () => {
  const validReview = {
    score: 0.9,
    issues: [{ severity: "high", description: "Missing error handling" }],
  };

  it("parses Shape 1: JSON string in content field", () => {
    const result = _extractReviewOutput({ content: JSON.stringify(validReview) }, "reviewer-1");
    expect(result.score).toBe(0.9);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].description).toBe("Missing error handling");
  });

  it("parses Shape 2: parts array with text", () => {
    const result = _extractReviewOutput({ parts: [{ text: JSON.stringify(validReview) }] }, "reviewer-1");
    expect(result.score).toBe(0.9);
    expect(result.issues).toHaveLength(1);
  });

  it("parses Shape 3: result object already parsed", () => {
    const result = _extractReviewOutput({ result: { ...validReview } }, "reviewer-1");
    expect(result.score).toBe(0.9);
    expect(result.issues).toHaveLength(1);
  });

  it("parses Shape 4: direct object with score", () => {
    const result = _extractReviewOutput({ ...validReview }, "reviewer-1");
    expect(result.score).toBe(0.9);
    expect(result.issues).toHaveLength(1);
  });

  it("clamps score above 1 down to 1", () => {
    const result = _extractReviewOutput({ content: JSON.stringify({ score: 1.5, issues: [] }) }, "reviewer-1");
    expect(result.score).toBe(1);
  });

  it("clamps score below 0 up to 0", () => {
    const result = _extractReviewOutput({ content: JSON.stringify({ score: -0.3, issues: [] }) }, "reviewer-1");
    expect(result.score).toBe(0);
  });

  it("defaults non-numeric score to 0.5", () => {
    const result = _extractReviewOutput({ content: JSON.stringify({ score: "high", issues: [] }) }, "reviewer-1");
    expect(result.score).toBe(0.5);
  });

  it("returns fallback for null response", () => {
    const result = _extractReviewOutput(null, "reviewer-1");
    expect(result.score).toBe(0.5);
    expect(result.issues).toEqual([]);
  });

  it("filters out issues missing required fields", () => {
    const review = {
      score: 0.7,
      issues: [
        { severity: "high", description: "Valid issue" },
        { severity: "low" },                              // missing description
        { description: "Missing severity" },               // missing severity
        { severity: "medium", description: "Also valid" },
      ],
    };
    const result = _extractReviewOutput({ content: JSON.stringify(review) }, "reviewer-1");
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].description).toBe("Valid issue");
    expect(result.issues[1].description).toBe("Also valid");
  });
});
