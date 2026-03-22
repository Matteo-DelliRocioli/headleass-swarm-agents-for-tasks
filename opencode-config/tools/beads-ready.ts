import { tool } from "@opencode-ai/plugin";
import { execFile } from "child_process";

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(
          new Error(
            `Command failed: ${cmd} ${args.join(" ")}\n${stderr || err.message}`
          )
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export default tool({
  description:
    "List ready (unblocked, unassigned) Beads tasks. Runs `bd ready --json` and returns the task list.",
  args: {},
  async execute() {
    try {
      const { stdout } = await run("bd", ["ready", "--json"]);

      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = stdout.trim();
      }

      return {
        success: true,
        tasks: parsed,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message ?? String(err),
      };
    }
  },
});
