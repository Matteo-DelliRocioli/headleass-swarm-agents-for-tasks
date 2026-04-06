import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { extractUsage, UsageAccumulator } from "../../src/usage-tracker.js";

// ---------------------------------------------------------------------------
// extractUsage
// ---------------------------------------------------------------------------
describe("extractUsage", () => {
  it("extracts from shape 1: { usage: { input_tokens, output_tokens } }", () => {
    const result = extractUsage({ usage: { input_tokens: 100, output_tokens: 50 } });
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it("extracts from shape 2: { metadata: { usage: { ... } } }", () => {
    const result = extractUsage({
      metadata: { usage: { input_tokens: 200, output_tokens: 80 } },
    });
    expect(result).toEqual({ inputTokens: 200, outputTokens: 80, totalTokens: 280 });
  });

  it("extracts from shape 3: { inputTokens, outputTokens }", () => {
    const result = extractUsage({ inputTokens: 300, outputTokens: 120 });
    expect(result).toEqual({ inputTokens: 300, outputTokens: 120, totalTokens: 420 });
  });

  it("returns zeros for null", () => {
    expect(extractUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("returns zeros for undefined", () => {
    expect(extractUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("returns zeros for an empty object", () => {
    expect(extractUsage({})).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});

// ---------------------------------------------------------------------------
// UsageAccumulator
// ---------------------------------------------------------------------------
describe("UsageAccumulator", () => {
  it("starts with zero total", () => {
    const acc = new UsageAccumulator("anthropic/claude-sonnet-4-20250514");
    expect(acc.getTotal()).toBe(0);
  });

  it("accumulates usage for a single agent", () => {
    const acc = new UsageAccumulator("anthropic/claude-sonnet-4-20250514");
    acc.add("agent-1", { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    acc.add("agent-1", { inputTokens: 200, outputTokens: 100, totalTokens: 300 });

    expect(acc.getTotal()).toBe(450);
    expect(acc.getPerAgent()).toEqual({ "agent-1": 450 });
  });

  it("accumulates usage across multiple agents", () => {
    const acc = new UsageAccumulator("anthropic/claude-sonnet-4-20250514");
    acc.add("agent-1", { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    acc.add("agent-2", { inputTokens: 200, outputTokens: 100, totalTokens: 300 });

    expect(acc.getTotal()).toBe(450);
    expect(acc.getPerAgent()).toEqual({ "agent-1": 150, "agent-2": 300 });
  });

  it("estimates cost for sonnet model (strips provider prefix)", () => {
    const acc = new UsageAccumulator("anthropic/claude-sonnet-4-20250514");
    // 1M input tokens = $3.00, 1M output tokens = $15.00
    acc.add("agent-1", { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 });

    expect(acc.getEstimatedCostUsd()).toBe(18.0);
  });

  it("uses default pricing for unknown model", () => {
    const acc = new UsageAccumulator("some-provider/unknown-model");
    // Default: input=3.0/M, output=15.0/M
    acc.add("agent-1", { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 });

    expect(acc.getEstimatedCostUsd()).toBe(18.0);
  });

  it("rounds estimated cost to cents", () => {
    const acc = new UsageAccumulator("anthropic/claude-sonnet-4-20250514");
    // Small usage that produces fractional cents
    acc.add("agent-1", { inputTokens: 333, outputTokens: 777, totalTokens: 1110 });

    // input cost: 333/1M * 3.0 = 0.000999
    // output cost: 777/1M * 15.0 = 0.011655
    // total: 0.012654 → rounded to 0.01
    expect(acc.getEstimatedCostUsd()).toBe(0.01);
  });

  it("getPerAgent returns Record<string, number> of totalTokens", () => {
    const acc = new UsageAccumulator("anthropic/claude-sonnet-4-20250514");
    acc.add("planner", { inputTokens: 500, outputTokens: 200, totalTokens: 700 });
    acc.add("coder", { inputTokens: 1000, outputTokens: 400, totalTokens: 1400 });

    const perAgent = acc.getPerAgent();
    expect(perAgent).toEqual({ planner: 700, coder: 1400 });
  });
});
