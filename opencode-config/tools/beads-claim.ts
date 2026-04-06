import { tool } from "@opencode-ai/plugin";
import { runBd } from "./_bd-limiter.js";

export default tool({
  description:
    "Claim a Beads task for the current agent. Runs `bd update <taskId> --claim --json` and returns the result.",
  args: {
    taskId: {
      type: "string",
      description: "The Beads task ID to claim",
    },
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

      return {
        success: true,
        taskId: args.taskId,
        result: parsed,
      };
    } catch (err: any) {
      return {
        success: false,
        taskId: args.taskId,
        error: err.message ?? String(err),
      };
    }
  },
});
