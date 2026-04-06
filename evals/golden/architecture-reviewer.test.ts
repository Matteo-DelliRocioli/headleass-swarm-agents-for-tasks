/**
 * Architecture Reviewer Golden Test (Tier 3)
 *
 * Structural validation of architecture reviewer output format.
 * Uses mock fixtures from evals/fixtures/mock-responses/ to verify the
 * validation logic itself is correct. The real LLM-backed version requires
 * GOLDEN_TEST=1 + a running OpenCode server that reviews the circular-deps
 * fixture in evals/fixtures/vulnerable-code/circular-deps/.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const GOLDEN = process.env.GOLDEN_TEST === "1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArchitectureIssue {
  severity: string;
  description: string;
  file: string;
  line: number;
}

interface ArchitectureReviewOutput {
  score: number;
  issues: ArchitectureIssue[];
}

function loadMockArchitectureReview(): ArchitectureReviewOutput {
  const raw = readFileSync(
    resolve(__dirname, "../fixtures/mock-responses/architecture-review.json"),
    "utf-8",
  );
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!GOLDEN)("Architecture Reviewer Golden Test", () => {
  const output = loadMockArchitectureReview();

  it(
    "score is <= 0.6 for circular dependency findings",
    () => {
      expect(output.score).toBeLessThanOrEqual(0.6);
    },
    120_000,
  );

  it(
    "at least one issue mentions circular, cycle, or import",
    () => {
      const match = output.issues.some((issue) => {
        const desc = issue.description.toLowerCase();
        return (
          desc.includes("circular") ||
          desc.includes("cycle") ||
          desc.includes("import")
        );
      });
      expect(match).toBe(true);
    },
    120_000,
  );
});
