import { z } from "zod";
import { tool } from "@opencode-ai/plugin";
import { runBd } from "./_bd-limiter.js";

export default tool({
  description:
    "Close a Beads task with a completion message. Runs `bd close <taskId>` and returns success or failure.",
  args: {
    taskId: z.string().describe("The Beads task ID to close"),
  },
  async execute(args) {
    try {
      const { stdout } = await runBd(["close", args.taskId]);

      return JSON.stringify({
        success: true,
        taskId: args.taskId,
        output: stdout.trim(),
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
