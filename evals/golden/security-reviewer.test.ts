/**
 * Security Reviewer Golden Test (Tier 3)
 *
 * Structural validation of security reviewer output format and constraints.
 * Uses mock fixtures from evals/fixtures/mock-responses/ to verify the
 * validation logic itself is correct. The real LLM-backed version requires
 * GOLDEN_TEST=1 + a running OpenCode server that reviews the vulnerable-code
 * fixtures in evals/fixtures/vulnerable-code/.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const GOLDEN = process.env.GOLDEN_TEST === "1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SecurityIssue {
  severity: string;
  description: string;
  file: string;
  line: number;
}

interface SecurityReviewOutput {
  score: number;
  issues: SecurityIssue[];
}

function loadMockSecurityReview(): SecurityReviewOutput {
  const raw = readFileSync(
    resolve(__dirname, "../fixtures/mock-responses/security-review.json"),
    "utf-8",
  );
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!GOLDEN)("Security Reviewer Golden Test", () => {
  const output = loadMockSecurityReview();

  it(
    "score is <= 0.4 for critical findings",
    () => {
      expect(output.score).toBeLessThanOrEqual(0.4);
    },
    120_000,
  );

  it(
    "at least one issue mentions injection or SQL",
    () => {
      const match = output.issues.some((issue) => {
        const desc = issue.description.toLowerCase();
        return desc.includes("injection") || desc.includes("sql");
      });
      expect(match).toBe(true);
    },
    120_000,
  );

  it(
    "at least one issue mentions secret, key, or hardcoded",
    () => {
      const match = output.issues.some((issue) => {
        const desc = issue.description.toLowerCase();
        return (
          desc.includes("secret") ||
          desc.includes("key") ||
          desc.includes("hardcoded")
        );
      });
      expect(match).toBe(true);
    },
    120_000,
  );

  it(
    "all issues have a non-empty description",
    () => {
      for (const issue of output.issues) {
        expect(issue.description).toBeTruthy();
        expect(issue.description.length).toBeGreaterThan(0);
      }
    },
    120_000,
  );
});
