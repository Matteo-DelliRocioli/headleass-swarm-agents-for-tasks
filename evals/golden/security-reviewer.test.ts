/**
 * Security Reviewer Golden Test (Tier 3)
 *
 * Two modes:
 *   1. Structural validation (always runs) — loads mock fixtures and validates
 *      the JSON structure and constraint-checking logic.
 *   2. LLM validation (GOLDEN_TEST=1 + OpenCode server) — sends vulnerable
 *      code fixtures to the security reviewer persona and validates live output.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const GOLDEN = process.env.GOLDEN_TEST === "1";
const OPENCODE_URL =
  process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

interface SecurityIssue {
  severity: string;
  description: string;
  file: string;
  line: number;
}

interface SecurityReviewOutput {
  score: number;
  issues: SecurityIssue[];
}

function loadMockSecurityReview(): SecurityReviewOutput {
  const raw = readFileSync(
    resolve(__dirname, "../fixtures/mock-responses/security-review.json"),
    "utf-8",
  );
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// 1. Structural validation (always runs)
// ---------------------------------------------------------------------------

describe("Security Reviewer Structural Validation", () => {
  const output = loadMockSecurityReview();

  it("score is <= 0.4 for critical findings", () => {
    expect(output.score).toBeLessThanOrEqual(0.4);
  });

  it("at least one issue mentions injection or SQL", () => {
    const match = output.issues.some((issue) => {
      const desc = issue.description.toLowerCase();
      return desc.includes("injection") || desc.includes("sql");
    });
    expect(match).toBe(true);
  });

  it("at least one issue mentions secret, key, or hardcoded", () => {
    const match = output.issues.some((issue) => {
      const desc = issue.description.toLowerCase();
      return (
        desc.includes("secret") ||
        desc.includes("key") ||
        desc.includes("hardcoded")
      );
    });
    expect(match).toBe(true);
  });

  it("all issues have a non-empty description", () => {
    for (const issue of output.issues) {
      expect(issue.description).toBeTruthy();
      expect(issue.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. LLM validation (gated behind GOLDEN_TEST=1)
// ---------------------------------------------------------------------------

describe.skipIf(!GOLDEN)("Security Reviewer LLM Validation", () => {
  let client: any;
  let serverAvailable = false;

  beforeAll(async () => {
    try {
      const resp = await fetch(OPENCODE_URL, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok && resp.status !== 404) {
        throw new Error(`Server returned ${resp.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `\nSkipping LLM security-reviewer tests: OpenCode server not reachable at ${OPENCODE_URL}`,
      );
      console.log(`Error: ${msg}\n`);
      return;
    }

    const { createOpencodeClient } = await import("@opencode-ai/sdk");
    client = createOpencodeClient({ baseUrl: OPENCODE_URL });
    serverAvailable = true;
  });

  it(
    "detects injection and secrets in vulnerable code fixtures",
    async () => {
      if (!serverAvailable) return;

      const personaPrompt = readFileSync(
        resolve(__dirname, "../../personas/security-reviewer.md"),
        "utf-8",
      );

      const sqlInjectionCode = readFileSync(
        resolve(
          __dirname,
          "../fixtures/vulnerable-code/sql-injection.ts",
        ),
        "utf-8",
      );
      const hardcodedSecretsCode = readFileSync(
        resolve(
          __dirname,
          "../fixtures/vulnerable-code/hardcoded-secrets.ts",
        ),
        "utf-8",
      );

      const session = await client.session.create({
        body: { title: "golden-security-eval" },
      });
      const sessionId = session.id ?? session.data?.id;

      // Inject persona as system context
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          noReply: true,
          parts: [
            {
              type: "text",
              text: `You are the security reviewer agent. Follow these instructions:\n\n${personaPrompt}`,
            },
          ],
        },
      });

      // Send the vulnerable code for review
      const response = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [
            {
              type: "text",
              text: [
                "Review the following code for security vulnerabilities.",
                "",
                "--- sql-injection.ts ---",
                sqlInjectionCode,
                "",
                "--- hardcoded-secrets.ts ---",
                hardcodedSecretsCode,
              ].join("\n"),
            },
          ],
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                score: { type: "number" },
                issues: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      severity: { type: "string" },
                      description: { type: "string" },
                      file: { type: "string" },
                      line: { type: "number" },
                    },
                    required: ["severity", "description", "file", "line"],
                  },
                },
              },
              required: ["score", "issues"],
            },
          },
        },
      });

      // Parse structured output
      const res = response as Record<string, unknown>;
      let parsed: SecurityReviewOutput | undefined;

      if (typeof res.content === "string") {
        try {
          parsed = JSON.parse(res.content);
        } catch {
          /* */
        }
      }
      if (!parsed && Array.isArray(res.parts)) {
        for (const part of res.parts as Array<Record<string, unknown>>) {
          if (typeof part.text === "string") {
            try {
              parsed = JSON.parse(part.text);
              break;
            } catch {
              /* */
            }
          }
        }
      }
      if (!parsed && typeof res.score === "number") {
        parsed = res as unknown as SecurityReviewOutput;
      }

      expect(parsed).toBeDefined();

      // score <= 0.5 for code with critical vulns
      expect(parsed!.score).toBeLessThanOrEqual(0.5);

      // at least one issue mentions injection or SQL
      const hasInjection = parsed!.issues.some((issue) => {
        const desc = issue.description.toLowerCase();
        return desc.includes("injection") || desc.includes("sql");
      });
      expect(hasInjection).toBe(true);

      // all issues have non-empty descriptions
      for (const issue of parsed!.issues) {
        expect(issue.description).toBeTruthy();
        expect(issue.description.length).toBeGreaterThan(0);
      }
    },
    120_000,
  );
});
