import { describe, it, expect } from "vitest";

const GOLDEN = process.env.GOLDEN_TEST === "1";

describe.skipIf(!GOLDEN)("QA Evaluator Golden Test", () => {
  it.todo("should start reference app and evaluate with Playwright");
  it.todo("should report app_started correctly");
  it.todo("should detect known bugs in reference app");
});
