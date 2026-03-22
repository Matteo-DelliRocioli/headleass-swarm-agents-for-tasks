// ---------------------------------------------------------------------------
// Beads CLI wrapper — async functions around the `bd` command
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./logger";
import { withRetry } from "./errors";

const execFileAsync = promisify(execFile);

const BD = "bd";

async function runBd(args: string[]): Promise<string> {
  logger.debug("Running bd command", { args });
  const { stdout } = await execFileAsync(BD, args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

export class BeadsQueue {
  constructor(private readonly log: typeof logger) {}

  /**
   * Create a new Beads issue for a SwarmRun.
   * Returns the newly created issue ID.
   */
  async createIssue(prompt: string, priority: number): Promise<string> {
    return withRetry(
      async () => {
        const title = `SwarmRun: ${prompt.slice(0, 60)}`;
        const output = await runBd([
          "create",
          title,
          "-t",
          "task",
          "-p",
          String(priority),
          "--json",
        ]);
        const parsed = JSON.parse(output);
        const id = parsed.id ?? parsed.ID ?? parsed.issueId;
        if (!id) {
          throw new Error(`bd create returned no id: ${output}`);
        }
        this.log.info("Created Beads issue", { id, title });
        return String(id);
      },
      { maxRetries: 3, baseDelay: 1000 },
    );
  }

  /**
   * Attempt to claim an issue.  Returns true if successfully claimed,
   * false if the issue was already claimed by another runner.
   */
  async claimIssue(issueId: string): Promise<boolean> {
    return withRetry(
      async () => {
        try {
          const output = await runBd(["update", issueId, "--claim", "--json"]);
          const parsed = JSON.parse(output);
          const claimed = parsed.claimed ?? parsed.status === "in_progress";
          this.log.info("Claimed Beads issue", { issueId, claimed });
          return Boolean(claimed);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("already claimed") || msg.includes("in_progress") || msg.includes("conflict")) {
            // Already in_progress = claimed by a previous operator lifecycle. That's fine.
            this.log.info("Issue already in_progress, treating as claimed", { issueId });
            return true;
          }
          throw err;
        }
      },
      { maxRetries: 3, baseDelay: 1000 },
    );
  }

  /**
   * Close an issue, optionally providing a reason.
   */
  async closeIssue(issueId: string, reason?: string): Promise<void> {
    return withRetry(
      async () => {
        const args = ["close", issueId];
        if (reason) {
          args.push("--reason", reason);
        }
        await runBd(args);
        this.log.info("Closed Beads issue", { issueId, reason });
      },
      { maxRetries: 3, baseDelay: 1000 },
    );
  }

  /**
   * Return all issues in the ready queue.
   */
  async getReady(): Promise<Array<{ id: string; title: string; priority: number }>> {
    return withRetry(
      async () => {
        const output = await runBd(["ready", "--json"]);
        const parsed = JSON.parse(output);
        const items = Array.isArray(parsed) ? parsed : parsed.issues ?? [];
        return items.map((item: Record<string, unknown>) => ({
          id: String(item.id ?? item.ID),
          title: String(item.title ?? ""),
          priority: Number(item.priority ?? 2),
        }));
      },
      { maxRetries: 3, baseDelay: 1000 },
    );
  }

  /**
   * Count issues currently in progress.
   */
  async countInProgress(): Promise<number> {
    return withRetry(
      async () => {
        const output = await runBd(["list", "--json", "--status", "in_progress"]);
        const parsed = JSON.parse(output);
        const items = Array.isArray(parsed) ? parsed : parsed.issues ?? [];
        return items.length;
      },
      { maxRetries: 3, baseDelay: 1000 },
    );
  }
}
