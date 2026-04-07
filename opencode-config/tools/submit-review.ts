import { z } from "zod";
import { tool } from "@opencode-ai/plugin";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

const SwarmStatePath = process.env.SWARM_STATE_PATH ?? "/workspace/.swarm";

/**
 * submit_review — called by reviewer agents (security, quality, architecture,
 * qa-evaluator) to submit their structured assessment.
 *
 * The args ARE the structured review. Written to
 * /workspace/.swarm/reviews/{sessionID}.json which the orchestrator reads.
 */
export default tool({
  description:
    "Submit your code review. Call this as your FINAL action — do not also output JSON in your message. The args ARE the review; the orchestrator will read them directly.",
  args: {
    score: z
      .number()
      .min(0)
      .max(1)
      .describe("Quality score from 0.0 (broken) to 1.0 (excellent)"),
    issues: z
      .array(
        z.object({
          severity: z
            .enum(["critical", "high", "medium", "low"])
            .describe("critical=blocks shipping, high=major bug, medium=should fix, low=nitpick"),
          description: z
            .string()
            .describe("What's wrong and how to fix it"),
          file: z
            .string()
            .optional()
            .describe("Relative path to the affected file (if applicable)"),
          line: z
            .number()
            .int()
            .optional()
            .describe("Line number of the issue (if applicable)"),
        }),
      )
      .describe("List of issues found (empty array if no issues)"),
  },
  async execute(args, context) {
    const filePath = `${SwarmStatePath}/reviews/${context.sessionID}.json`;

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({ score: args.score, issues: args.issues }, null, 2),
      );
      return JSON.stringify({
        success: true,
        message: `Review submitted: score ${args.score}, ${args.issues.length} issues. Stop now.`,
        path: filePath,
      });
    } catch (err: any) {
      return JSON.stringify({
        success: false,
        error: err.message ?? String(err),
      });
    }
  },
});
