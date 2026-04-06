/**
 * QA Evaluator Golden Test (Tier 3)
 *
 * Two modes:
 *   1. Structural validation (always runs) — placeholder, no mock fixtures yet.
 *   2. LLM validation (GOLDEN_TEST=1) — requires Playwright + a running app,
 *      so tests remain as `it.todo()` for now.
 */
import { describe, it } from "vitest";

const GOLDEN = process.env.GOLDEN_TEST === "1";

// ---------------------------------------------------------------------------
// 1. Structural validation (always runs)
// ---------------------------------------------------------------------------

describe("QA Evaluator Structural Validation", () => {
  it.todo("should validate mock QA evaluator output structure");
});

// ---------------------------------------------------------------------------
// 2. LLM validation (gated behind GOLDEN_TEST=1)
// ---------------------------------------------------------------------------

describe.skipIf(!GOLDEN)("QA Evaluator LLM Validation", () => {
  it.todo("should start reference app and evaluate with Playwright");
  it.todo("should report app_started correctly");
  it.todo("should detect known bugs in reference app");
});
