import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { loadPersonas, matchPersonaToTask, type Persona } from "../../src/persona-loader.js";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

async function makeTmpDir(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "persona-test-"));
  return tmpDir;
}

function mdWithFrontmatter(fields: Record<string, string>, body = ""): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// loadPersonas
// ---------------------------------------------------------------------------

describe("loadPersonas", () => {
  it("parses frontmatter correctly", async () => {
    const dir = await makeTmpDir();
    const content = mdWithFrontmatter(
      { description: "A frontend specialist", write: "true", edit: "true" },
      "\n# Frontend Dev\nBuild UIs.",
    );
    await writeFile(join(dir, "frontend-dev.md"), content);

    const personas = await loadPersonas(dir);

    expect(personas.size).toBe(1);
    const p = personas.get("frontend-dev")!;
    expect(p.id).toBe("frontend-dev");
    expect(p.description).toBe("A frontend specialist");
    expect(p.isReviewer).toBe(false);
    expect(p.content).toBe(content);
  });

  it("marks isReviewer true when both write and edit are false", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "reviewer.md"),
      mdWithFrontmatter({ description: "Code reviewer", write: "false", edit: "false" }),
    );

    const personas = await loadPersonas(dir);
    expect(personas.get("reviewer")!.isReviewer).toBe(true);
  });

  it("marks isReviewer false when only write is false", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "half.md"),
      mdWithFrontmatter({ description: "Half restricted", write: "false", edit: "true" }),
    );

    const personas = await loadPersonas(dir);
    expect(personas.get("half")!.isReviewer).toBe(false);
  });

  it("marks isReviewer false when both write and edit are true", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "dev.md"),
      mdWithFrontmatter({ description: "Developer", write: "true", edit: "true" }),
    );

    const personas = await loadPersonas(dir);
    expect(personas.get("dev")!.isReviewer).toBe(false);
  });

  it("defaults description to id when frontmatter is missing", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "bare-agent.md"), "# No frontmatter here\nJust content.");

    const personas = await loadPersonas(dir);
    const p = personas.get("bare-agent")!;
    expect(p.description).toBe("bare-agent");
  });

  it("returns empty map for empty directory", async () => {
    const dir = await makeTmpDir();
    const personas = await loadPersonas(dir);
    expect(personas.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// matchPersonaToTask
// ---------------------------------------------------------------------------

function buildPersonaMap(entries: Array<Partial<Persona> & { id: string }>): Map<string, Persona> {
  const map = new Map<string, Persona>();
  for (const e of entries) {
    map.set(e.id, {
      id: e.id,
      description: e.description ?? e.id,
      isReviewer: e.isReviewer ?? false,
      content: e.content ?? "",
    });
  }
  return map;
}

describe("matchPersonaToTask", () => {
  const personas = buildPersonaMap([
    { id: "frontend-dev" },
    { id: "backend-dev" },
    { id: "database-specialist" },
    { id: "master-reviewer", isReviewer: true },
  ]);

  it("suggestedPersona takes priority over keyword match", () => {
    // Title says "react" (frontend keyword) but suggested is backend-dev
    const result = matchPersonaToTask("Build a react component", undefined, personas, undefined, "backend-dev");
    expect(result?.id).toBe("backend-dev");
  });

  it("falls through to keywords when suggestedPersona is not in candidates", () => {
    const result = matchPersonaToTask("Build React login page", undefined, personas, undefined, "nonexistent-persona");
    expect(result?.id).toBe("frontend-dev");
  });

  it("matches frontend keywords", () => {
    const result = matchPersonaToTask("Build React login page", undefined, personas);
    expect(result?.id).toBe("frontend-dev");
  });

  it("matches database keywords", () => {
    const result = matchPersonaToTask("Set up PostgreSQL schema", undefined, personas);
    expect(result?.id).toBe("database-specialist");
  });

  it("never returns a reviewer persona", () => {
    // Even with a direct suggestion of the reviewer
    const result = matchPersonaToTask("Review code", undefined, personas, undefined, "master-reviewer");
    // master-reviewer is filtered out as a reviewer
    expect(result?.id).not.toBe("master-reviewer");
  });

  it("respects allowedPersonas filter", () => {
    // "react" would normally match frontend-dev, but it's not in allowedPersonas
    const result = matchPersonaToTask("Build React login page", undefined, personas, ["backend-dev", "database-specialist"]);
    expect(result?.id).not.toBe("frontend-dev");
  });

  it("returns undefined when nothing matches", () => {
    // Use title with no matching keywords and no suggested persona
    const result = matchPersonaToTask("Do something obscure and unrelated", undefined, personas);
    expect(result).toBeUndefined();
  });
});
