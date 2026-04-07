import { z } from "zod";
import { tool } from "@opencode-ai/plugin";
import { runBd } from "./_bd-limiter.js";

export default tool({
  description:
    "Claim a Beads task for the current agent. Runs `bd update <taskId> --claim --json` and returns the result.",
  args: {
    taskId: z.string().describe("The Beads task ID to claim"),
  },
  async execute(args) {
    try {
      const { stdout } = await runBd([
        "update",
        args.taskId,
        "--claim",
        "--json",
      ]);

      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = stdout.trim();
      }

      return JSON.stringify({
        success: true,
        taskId: args.taskId,
        result: parsed,
      });
    } catch (err: any) {
      return JSON.stringify({
        success: false,
        taskId: args.taskId,
        error: err.message ?? String(err),
      });
    }
  },
});
