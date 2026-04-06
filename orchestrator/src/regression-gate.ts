import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";

export interface GateResult {
  passed: boolean;
  commitSha: string;
  tscErrors: string[];
  testFailures: string[];
}

/**
 * Run regression gate: git commit, tsc, tests.
 * Returns GateResult with pass/fail and details.
 */
export async function runRegressionGate(
  workspacePath: string,
  loopNumber: number,
): Promise<GateResult> {
  const result: GateResult = {
    passed: true,
    commitSha: "",
    tscErrors: [],
    testFailures: [],
  };

  // Step 1: Git commit all changes
  try {
    execFileSync("git", ["add", "-A"], { cwd: workspacePath, timeout: 30000 });
    // Check if there are changes to commit
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: workspacePath, encoding: "utf-8", timeout: 10000 });
    if (status.trim()) {
      execFileSync("git", ["commit", "-m", `swarm: loop ${loopNumber} agent work`], { cwd: workspacePath, timeout: 30000 });
    }
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, encoding: "utf-8", timeout: 10000 }).trim();
    result.commitSha = sha;
    logger.info("Regression gate: git commit", { sha, loop: loopNumber });
  } catch (err) {
    logger.warn("Regression gate: git commit failed", { error: String(err) });
    // If git isn't initialized yet, initialize it
    try {
      execFileSync("git", ["init"], { cwd: workspacePath, timeout: 10000 });
      execFileSync("git", ["add", "-A"], { cwd: workspacePath, timeout: 30000 });
      execFileSync("git", ["commit", "-m", `swarm: loop ${loopNumber} agent work`], { cwd: workspacePath, timeout: 30000 });
      result.commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, encoding: "utf-8", timeout: 10000 }).trim();
    } catch {
      // git not available or workspace empty — continue without commit
    }
  }

  // Step 2: TypeScript check (if tsconfig.json exists)
  const tsconfigPath = join(workspacePath, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    try {
      execFileSync("npx", ["tsc", "--noEmit"], { cwd: workspacePath, encoding: "utf-8", timeout: 120000 });
      logger.info("Regression gate: tsc passed");
    } catch (err: any) {
      const stderr = err.stderr?.toString() ?? err.stdout?.toString() ?? String(err);
      // Parse individual error lines
      const errorLines = stderr
        .split("\n")
        .filter((line: string) => line.includes("error TS"))
        .map((line: string) => line.trim());

      if (errorLines.length > 0) {
        result.passed = false;
        result.tscErrors = errorLines;
        logger.warn("Regression gate: tsc failed", { errorCount: errorLines.length });
      }
    }
  }

  // Step 3: Test runner (if package.json has a test script)
  const pkgPath = join(workspacePath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test) {
        try {
          execFileSync("npm", ["test"], { cwd: workspacePath, encoding: "utf-8", timeout: 300000 }); // 5 min
          logger.info("Regression gate: tests passed");
        } catch (err: any) {
          const output = err.stdout?.toString() ?? err.stderr?.toString() ?? String(err);
          // Extract failure lines
          const failureLines = output
            .split("\n")
            .filter((line: string) => /fail|error|assert/i.test(line) && line.trim().length > 0)
            .slice(0, 20) // cap at 20 failure lines
            .map((line: string) => line.trim());

          if (failureLines.length > 0) {
            result.passed = false;
            result.testFailures = failureLines;
            logger.warn("Regression gate: tests failed", { failureCount: failureLines.length });
          }
        }
      }
    } catch {
      // Invalid package.json — skip tests
    }
  }

  logger.info("Regression gate complete", { passed: result.passed, loop: loopNumber });
  return result;
}
