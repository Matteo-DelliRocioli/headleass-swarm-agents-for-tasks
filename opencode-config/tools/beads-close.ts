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
    "Close a Beads task with a completion message. Runs `bd close <taskId>` and returns success or failure.",
  args: {
    taskId: {
      type: "string",
      description: "The Beads task ID to close",
    },
  },
  async execute(args) {
    try {
      const { stdout } = await run("bd", ["close", args.taskId]);

      return {
        success: true,
        taskId: args.taskId,
        output: stdout.trim(),
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
