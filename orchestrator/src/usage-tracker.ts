// ---------------------------------------------------------------------------
// Usage tracker — tracks token counts and estimated costs per agent
// ---------------------------------------------------------------------------

import { logger } from "./logger.js";

export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// Approximate pricing per 1M tokens (Sonnet 4 as default)
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-haiku-4-20250514": { input: 0.25, output: 1.25 },
};
const DEFAULT_PRICING = { input: 3.0, output: 15.0 };

/**
 * Extract usage data from an OpenCode SDK prompt response.
 * Tries common response shapes; returns zeros if nothing found.
 */
export function extractUsage(response: unknown): UsageData {
  const zero: UsageData = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  if (!response || typeof response !== "object") return zero;

  const res = response as Record<string, unknown>;

  // Shape 1: { usage: { input_tokens, output_tokens } }
  if (res.usage && typeof res.usage === "object") {
    const u = res.usage as Record<string, unknown>;
    const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
    const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
    return { inputTokens: input, outputTokens: output, totalTokens: input + output };
  }

  // Shape 2: { metadata: { usage: { ... } } }
  if (res.metadata && typeof res.metadata === "object") {
    const meta = res.metadata as Record<string, unknown>;
    if (meta.usage && typeof meta.usage === "object") {
      const u = meta.usage as Record<string, unknown>;
      const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
      const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
      return { inputTokens: input, outputTokens: output, totalTokens: input + output };
    }
  }

  // Shape 3: { inputTokens, outputTokens } (camelCase)
  if (typeof res.inputTokens === "number") {
    const input = res.inputTokens as number;
    const output = (typeof res.outputTokens === "number" ? res.outputTokens : 0) as number;
    return { inputTokens: input, outputTokens: output, totalTokens: input + output };
  }

  return zero;
}

/**
 * Accumulator that tracks per-agent and total usage.
 */
export class UsageAccumulator {
  private perAgent: Record<string, UsageData> = {};
  private model: string;

  constructor(model: string) {
    this.model = model;
  }

  /** Add usage for an agent (accumulates across multiple calls). */
  add(agentId: string, usage: UsageData): void {
    const existing = this.perAgent[agentId] ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this.perAgent[agentId] = {
      inputTokens: existing.inputTokens + usage.inputTokens,
      outputTokens: existing.outputTokens + usage.outputTokens,
      totalTokens: existing.totalTokens + usage.totalTokens,
    };
  }

  /** Get total token count across all agents. */
  getTotal(): number {
    return Object.values(this.perAgent).reduce((sum, u) => sum + u.totalTokens, 0);
  }

  /** Get per-agent token counts (for SwarmRunResult.tokenUsage.perAgent). */
  getPerAgent(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [agent, usage] of Object.entries(this.perAgent)) {
      result[agent] = usage.totalTokens;
    }
    return result;
  }

  /** Estimate cost in USD based on model pricing. */
  getEstimatedCostUsd(): number {
    const modelId = this.model.includes("/") ? this.model.split("/")[1] : this.model;
    const pricing = PRICING[modelId] ?? DEFAULT_PRICING;

    let totalCost = 0;
    for (const usage of Object.values(this.perAgent)) {
      totalCost += (usage.inputTokens / 1_000_000) * pricing.input;
      totalCost += (usage.outputTokens / 1_000_000) * pricing.output;
    }

    return Math.round(totalCost * 100) / 100; // Round to cents
  }

  /** Log a summary of usage. */
  logSummary(): void {
    const total = this.getTotal();
    const cost = this.getEstimatedCostUsd();
    const agentCount = Object.keys(this.perAgent).length;

    logger.info("Usage summary", {
      totalTokens: total,
      estimatedCostUsd: cost,
      agentCount,
      perAgent: this.getPerAgent(),
    });
  }
}
