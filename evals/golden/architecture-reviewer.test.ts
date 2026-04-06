/**
 * Architecture Reviewer Golden Test (Tier 3)
 *
 * Two modes:
 *   1. Structural validation (always runs) — loads mock fixtures and validates
 *      the JSON structure and constraint-checking logic.
 *   2. LLM validation (GOLDEN_TEST=1 + OpenCode server) — sends circular-deps
 *      fixture code to the architecture reviewer persona and validates live output.
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

interface ArchitectureIssue {
  severity: string;
  description: string;
  file: string;
  line: number;
}

interface ArchitectureReviewOutput {
  score: number;
  issues: ArchitectureIssue[];
}

function loadMockArchitectureReview(): ArchitectureReviewOutput {
  const raw = readFileSync(
    resolve(__dirname, "../fixtures/mock-responses/architecture-review.json"),
    "utf-8",
  );
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// 1. Structural validation (always runs)
// ---------------------------------------------------------------------------

describe("Architecture Reviewer Structural Validation", () => {
  const output = loadMockArchitectureReview();

  it("score is <= 0.6 for circular dependency findings", () => {
    expect(output.score).toBeLessThanOrEqual(0.6);
  });

  it("at least one issue mentions circular, cycle, or import", () => {
    const match = output.issues.some((issue) => {
      const desc = issue.description.toLowerCase();
      return (
        desc.includes("circular") ||
        desc.includes("cycle") ||
        desc.includes("import")
      );
    });
    expect(match).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. LLM validation (gated behind GOLDEN_TEST=1)
// ---------------------------------------------------------------------------

describe.skipIf(!GOLDEN)("Architecture Reviewer LLM Validation", () => {
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
        `\nSkipping LLM architecture-reviewer tests: OpenCode server not reachable at ${OPENCODE_URL}`,
      );
      console.log(`Error: ${msg}\n`);
      return;
    }

    const { createOpencodeClient } = await import("@opencode-ai/sdk");
    client = createOpencodeClient({ baseUrl: OPENCODE_URL });
    serverAvailable = true;
  });

  it(
    "detects circular dependencies in fixture code",
    async () => {
      if (!serverAvailable) return;

      const personaPrompt = readFileSync(
        resolve(__dirname, "../../personas/architecture-reviewer.md"),
        "utf-8",
      );

      const aCode = readFileSync(
        resolve(
          __dirname,
          "../fixtures/vulnerable-code/circular-deps/a.ts",
        ),
        "utf-8",
      );
      const bCode = readFileSync(
        resolve(
          __dirname,
          "../fixtures/vulnerable-code/circular-deps/b.ts",
        ),
        "utf-8",
      );
      const cCode = readFileSync(
        resolve(
          __dirname,
          "../fixtures/vulnerable-code/circular-deps/c.ts",
        ),
        "utf-8",
      );

      const session = await client.session.create({
        body: { title: "golden-architecture-eval" },
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
              text: `You are the architecture reviewer agent. Follow these instructions:\n\n${personaPrompt}`,
            },
          ],
        },
      });

      // Send the circular-deps code for review
      const response = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [
            {
              type: "text",
              text: [
                "Review the following code for architecture issues.",
                "",
                "--- circular-deps/a.ts ---",
                aCode,
                "",
                "--- circular-deps/b.ts ---",
                bCode,
                "",
                "--- circular-deps/c.ts ---",
                cCode,
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
      let parsed: ArchitectureReviewOutput | undefined;

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
        parsed = res as unknown as ArchitectureReviewOutput;
      }

      expect(parsed).toBeDefined();

      // at least one issue mentions circular or cycle
      const hasCircular = parsed!.issues.some((issue) => {
        const desc = issue.description.toLowerCase();
        return desc.includes("circular") || desc.includes("cycle");
      });
      expect(hasCircular).toBe(true);
    },
    120_000,
  );
});
