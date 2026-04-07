import { z } from "zod";
import { tool } from "@opencode-ai/plugin";
import { runBd } from "./_bd-limiter.js";

export default tool({
  description:
    "List ready (unblocked, unassigned) Beads tasks. Runs `bd ready --json` and returns the task list.",
  args: {},
  async execute() {
    try {
      const { stdout } = await runBd(["ready", "--json"]);

      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = stdout.trim();
      }

      return JSON.stringify({
        success: true,
        tasks: parsed,
      });
    } catch (err: any) {
      return JSON.stringify({
        success: false,
        error: err.message ?? String(err),
      });
    }
  },
});
