import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";

const E2E = process.env.E2E_TEST === "1";
const SWARMRUN_YAML = new URL("../fixtures/instagram-clone/swarmrun.yaml", import.meta.url).pathname;
const RUN_NAME = "instagram-clone-golden";
const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

function kubectl(cmd: string): string {
  return execSync(`kubectl ${cmd}`, { encoding: "utf-8", timeout: 30000 }).trim();
}

describe.skipIf(!E2E)("Instagram Clone E2E", () => {
  beforeAll(() => {
    // Verify cluster access
    expect(() => kubectl("cluster-info")).not.toThrow();
    // Apply the SwarmRun
    kubectl(`apply -f ${SWARMRUN_YAML}`);
  }, 60000);

  afterAll(() => {
    try { kubectl(`delete swarmrun ${RUN_NAME} --ignore-not-found`); } catch {}
  });

  it("should complete the SwarmRun within 30 minutes", async () => {
    const start = Date.now();
    let phase = "Unknown";
    let result: any = null;

    while (Date.now() - start < TIMEOUT_MS) {
      const json = kubectl(`get swarmrun ${RUN_NAME} -o json`);
      const sr = JSON.parse(json);
      phase = sr.status?.phase ?? "Unknown";

      if (["Completed", "Failed", "TimedOut"].includes(phase)) {
        result = sr.status;
        break;
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    expect(result).not.toBeNull();
    expect(phase).toBe("Completed");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  }, TIMEOUT_MS + 60000);
});
