import { tool } from "@opencode-ai/plugin";
import { readFile } from "fs/promises";
import { existsSync } from "fs";

export default tool({
  description:
    "Query the current swarm state. Reads /workspace/.swarm/state.json and returns active agents, their tasks, current loop, file locks, and pending messages.",
  args: {},
  async execute() {
    const statePath = "/workspace/.swarm/state.json";

    try {
      if (!existsSync(statePath)) {
        return {
          success: false,
          error: `Swarm state file not found at ${statePath}. The orchestrator may not have initialized yet.`,
        };
      }

      const raw = await readFile(statePath, "utf-8");
      const state = JSON.parse(raw);

      return {
        success: true,
        activeAgents: state.activeAgents ?? [],
        tasks: state.tasks ?? {},
        currentLoop: state.currentLoop ?? null,
        fileLocks: state.fileLocks ?? {},
        pendingMessages: state.pendingMessages ?? {},
        raw: state,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message ?? String(err),
      };
    }
  },
});
