import { execFile } from "child_process";

const MAX_CONCURRENT = 3;
let active = 0;
const queue: Array<() => void> = [];

export function runBd(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const execute = () => {
      active++;
      execFile("bd", args, { timeout: 30_000 }, (err, stdout, stderr) => {
        active--;
        const next = queue.shift();
        if (next) next();

        if (err) {
          reject(new Error(`Command failed: bd ${args.join(" ")}\n${stderr || err.message}`));
        } else {
          resolve({ stdout, stderr });
        }
      });
    };

    if (active < MAX_CONCURRENT) {
      execute();
    } else {
      queue.push(execute);
    }
  });
}
