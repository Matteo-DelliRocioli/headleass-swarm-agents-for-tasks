import { z } from "zod";
import { tool } from "@opencode-ai/plugin";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

const SwarmStatePath = process.env.SWARM_STATE_PATH ?? "/workspace/.swarm";

/**
 * submit_plan_review — called by the master-reviewer when reviewing a plan.
 *
 * The args ARE the structured review output. Written to
 * /workspace/.swarm/plan-reviews/{sessionID}.json which the orchestrator reads.
 */
export default tool({
  description:
    "Submit your review of a task decomposition plan. Call this as your FINAL action — do not also output JSON in your message. The args ARE the review; the orchestrator will read them directly.",
  args: {
    approved: z
      .boolean()
      .describe("True if the plan is good enough to execute, false if it needs revision"),
    score: z
      .number()
      .min(0)
      .max(1)
      .describe("Quality score from 0.0 to 1.0. 0.8+ means executable"),
    feedback: z
      .string()
      .describe("Plain-text summary of your assessment (1-3 sentences)"),
    issues: z
      .array(
        z.object({
          task_title: z
            .string()
            .describe("The exact title of the task this issue refers to"),
          issue: z
            .string()
            .describe("What's wrong and how to fix it"),
        }),
      )
      .optional()
      .describe("Specific issues per task (empty if everything is fine)"),
  },
  async execute(args, context) {
    const filePath = `${SwarmStatePath}/plan-reviews/${context.sessionID}.json`;

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify(
          {
            approved: args.approved,
            score: args.score,
            feedback: args.feedback,
            issues: args.issues ?? [],
          },
          null,
          2,
        ),
      );
      return JSON.stringify({
        success: true,
        message: `Plan review submitted: ${args.approved ? "APPROVED" : "NEEDS REVISION"} (score ${args.score}). Stop now.`,
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
