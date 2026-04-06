import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { aggregateReviews } from "../../src/review-aggregator.js";

interface ReviewIssue {
  severity: "critical" | "high" | "medium" | "low";
  file?: string;
  line?: number;
  description: string;
}

interface ReviewResult {
  reviewerId: string;
  score: number;
  issues: ReviewIssue[];
}

describe("aggregateReviews", () => {
  it("returns defaults for empty input", () => {
    const result = aggregateReviews([]);
    expect(result.confidence).toBe(0);
    expect(result.reviewCount).toBe(0);
    expect(result.perReviewer).toEqual([]);
    expect(result.criticalIssues).toEqual([]);
    expect(result.allIssues).toEqual([]);
    expect(result.followUpTasks).toEqual([]);
  });

  it("computes weighted scoring across known reviewers", () => {
    const reviews: ReviewResult[] = [
      { reviewerId: "security-reviewer", score: 0.8, issues: [] },
      { reviewerId: "quality-reviewer", score: 0.9, issues: [] },
      { reviewerId: "architecture-reviewer", score: 0.7, issues: [] },
      { reviewerId: "qa-evaluator", score: 0.85, issues: [] },
    ];

    const result = aggregateReviews(reviews);

    // weightedSum = 0.8*1.5 + 0.9*1.0 + 0.7*1.2 + 0.85*1.4 = 1.2 + 0.9 + 0.84 + 1.19 = 4.13
    // totalWeight = 1.5 + 1.0 + 1.2 + 1.4 = 5.1
    // confidence = Math.round((4.13 / 5.1) * 100) / 100 = 0.81
    expect(result.confidence).toBe(0.81);
    expect(result.reviewCount).toBe(4);
    expect(result.perReviewer).toHaveLength(4);
  });

  it("defaults unknown reviewer weight to 1.0", () => {
    const reviews: ReviewResult[] = [
      { reviewerId: "unknown-reviewer", score: 0.5, issues: [] },
      { reviewerId: "security-reviewer", score: 1.0, issues: [] },
    ];

    const result = aggregateReviews(reviews);

    // weightedSum = 0.5*1.0 + 1.0*1.5 = 0.5 + 1.5 = 2.0
    // totalWeight = 1.0 + 1.5 = 2.5
    // confidence = Math.round((2.0 / 2.5) * 100) / 100 = 0.8
    expect(result.confidence).toBe(0.8);
    expect(result.reviewCount).toBe(2);
  });

  it("handles a single reviewer", () => {
    const reviews: ReviewResult[] = [
      {
        reviewerId: "master-reviewer",
        score: 0.75,
        issues: [
          { severity: "low", description: "Minor style issue" },
        ],
      },
    ];

    const result = aggregateReviews(reviews);

    // weightedSum = 0.75*1.0 = 0.75, totalWeight = 1.0
    // confidence = Math.round((0.75 / 1.0) * 100) / 100 = 0.75
    expect(result.confidence).toBe(0.75);
    expect(result.reviewCount).toBe(1);
    expect(result.perReviewer).toEqual([
      { id: "master-reviewer", score: 0.75, issueCount: 1 },
    ]);
    expect(result.allIssues).toHaveLength(1);
  });

  it("always marks severity=critical issues as critical", () => {
    const criticalIssue: ReviewIssue = {
      severity: "critical",
      file: "src/auth.ts",
      line: 42,
      description: "SQL injection vulnerability in user input handler",
    };

    const reviews: ReviewResult[] = [
      {
        reviewerId: "security-reviewer",
        score: 0.3,
        issues: [criticalIssue],
      },
    ];

    const result = aggregateReviews(reviews);

    expect(result.criticalIssues).toHaveLength(1);
    expect(result.criticalIssues[0]).toEqual(criticalIssue);
  });

  it("marks issues as critical when two different reviewers flag same file with similar description", () => {
    const issueA: ReviewIssue = {
      severity: "medium",
      file: "src/api.ts",
      line: 10,
      description: "Unvalidated input could cause issues in production environments",
    };

    const issueB: ReviewIssue = {
      severity: "low",
      file: "src/api.ts",
      line: 15,
      description: "Unvalidated input co—different ending but same start",
    };

    const reviews: ReviewResult[] = [
      {
        reviewerId: "security-reviewer",
        score: 0.6,
        issues: [issueA],
      },
      {
        reviewerId: "quality-reviewer",
        score: 0.7,
        issues: [issueB],
      },
    ];

    const result = aggregateReviews(reviews);

    // Same file + first 20 chars match ("Unvalidated input co") → both critical
    expect(result.criticalIssues).toContainEqual(issueA);
    expect(result.criticalIssues).toContainEqual(issueB);
  });

  it("deduplicates follow-up tasks by file + first 30 chars of description", () => {
    const issueA: ReviewIssue = {
      severity: "critical",
      file: "src/db.ts",
      line: 5,
      description: "Connection pool exhaustion unde high-load scenario alpha",
    };

    const issueB: ReviewIssue = {
      severity: "critical",
      file: "src/db.ts",
      line: 20,
      description: "Connection pool exhaustion unde high-load scenario beta version",
    };

    const reviews: ReviewResult[] = [
      {
        reviewerId: "security-reviewer",
        score: 0.4,
        issues: [issueA],
      },
      {
        reviewerId: "architecture-reviewer",
        score: 0.5,
        issues: [issueB],
      },
    ];

    const result = aggregateReviews(reviews);

    // Both are severity=critical so both in criticalIssues
    expect(result.criticalIssues).toHaveLength(2);

    // Same file + first 30 chars match → deduplicated to one follow-up task
    expect(result.followUpTasks).toHaveLength(1);
  });

  it("formats follow-up tasks with correct title prefix and priority mapping", () => {
    const criticalIssue: ReviewIssue = {
      severity: "critical",
      file: "src/auth.ts",
      description: "SQL injection vulnerability found in the authentication module handler code path",
    };

    const highIssue: ReviewIssue = {
      severity: "high",
      file: "src/config.ts",
      description: "Sensitive credentials exposed in configuration file without encryption",
    };

    // Make highIssue critical by having two reviewers flag similar issue
    const highIssueSimilar: ReviewIssue = {
      severity: "high",
      file: "src/config.ts",
      description: "Sensitive credentials ex—flagged by second reviewer as well",
    };

    const reviews: ReviewResult[] = [
      {
        reviewerId: "security-reviewer",
        score: 0.3,
        issues: [criticalIssue, highIssue],
      },
      {
        reviewerId: "quality-reviewer",
        score: 0.5,
        issues: [highIssueSimilar],
      },
    ];

    const result = aggregateReviews(reviews);

    // criticalIssue by severity, highIssue + highIssueSimilar by similarity
    const criticalTask = result.followUpTasks.find(
      (t) => t.priority === 0
    );
    expect(criticalTask).toBeDefined();
    expect(criticalTask!.title).toBe(
      "Fix: " + criticalIssue.description.slice(0, 60)
    );
    expect(criticalTask!.priority).toBe(0);

    // highIssue was promoted to critical via similarity — its follow-up should use its own severity for priority
    const highTask = result.followUpTasks.find((t) => t.priority === 1);
    expect(highTask).toBeDefined();
    expect(highTask!.title.startsWith("Fix: ")).toBe(true);
  });

  it("does not include issues in criticalIssues if not severity=critical and not flagged by 2+ reviewers", () => {
    const mediumIssue: ReviewIssue = {
      severity: "medium",
      file: "src/utils.ts",
      line: 100,
      description: "Unused variable should be removed for clarity",
    };

    const lowIssue: ReviewIssue = {
      severity: "low",
      file: "src/helpers.ts",
      line: 50,
      description: "Consider renaming function for better readability",
    };

    const reviews: ReviewResult[] = [
      {
        reviewerId: "quality-reviewer",
        score: 0.9,
        issues: [mediumIssue, lowIssue],
      },
    ];

    const result = aggregateReviews(reviews);

    expect(result.criticalIssues).toHaveLength(0);
    expect(result.allIssues).toHaveLength(2);
    expect(result.followUpTasks).toHaveLength(0);
  });
});
