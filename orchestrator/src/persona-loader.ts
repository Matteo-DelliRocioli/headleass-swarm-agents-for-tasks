// ---------------------------------------------------------------------------
// Persona loader — reads persona .md files and maps them to tasks
// ---------------------------------------------------------------------------

import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { logger } from "./logger.js";

export interface Persona {
  id: string;         // filename without .md (e.g., "frontend-dev")
  description: string; // from YAML frontmatter
  isReviewer: boolean; // tools.write === false
  content: string;     // full file content
}

export async function loadPersonas(personasPath: string): Promise<Map<string, Persona>> {
  const personas = new Map<string, Persona>();

  try {
    const files = await readdir(personasPath);
    const mdFiles = files.filter(f => f.endsWith(".md"));

    for (const file of mdFiles) {
      const content = await readFile(join(personasPath, file), "utf-8");
      const id = basename(file, ".md");
      const description = extractFrontmatter(content, "description") ?? id;
      const writeDisabled = extractFrontmatter(content, "write") === "false";
      const editDisabled = extractFrontmatter(content, "edit") === "false";

      personas.set(id, {
        id,
        description,
        isReviewer: writeDisabled && editDisabled,
        content,
      });
    }
  } catch (err) {
    logger.error("Failed to load personas", { path: personasPath, error: String(err) });
  }

  logger.info("Loaded personas", {
    count: personas.size,
    ids: [...personas.keys()],
    reviewers: [...personas.values()].filter(p => p.isReviewer).map(p => p.id),
  });

  return personas;
}

function extractFrontmatter(content: string, key: string): string | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  const frontmatter = match[1];
  const lineMatch = frontmatter.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
  return lineMatch?.[1]?.trim();
}

/**
 * Match a task to the best persona.
 * Priority: 1) planner's suggestedPersona, 2) keyword matching, 3) undefined.
 * Returns undefined if no match — caller must handle (fail-fast, not skip).
 */
export function matchPersonaToTask(
  taskTitle: string,
  taskDescription: string | undefined,
  personas: Map<string, Persona>,
  allowedPersonas?: string[],
  suggestedPersona?: string,
): Persona | undefined {
  const candidates = [...personas.values()]
    .filter(p => !p.isReviewer) // Only implementation personas
    .filter(p => !allowedPersonas || allowedPersonas.includes(p.id));

  // Priority 1: Use planner's suggestion if available and valid
  if (suggestedPersona) {
    const suggested = candidates.find(p => p.id === suggestedPersona);
    if (suggested) return suggested;
    logger.warn("Suggested persona not in candidates", {
      suggestedPersona,
      available: candidates.map(c => c.id),
    });
  }

  // Priority 2: Score-based keyword matching (count hits per persona, return highest)
  const text = `${taskTitle} ${taskDescription ?? ""}`.toLowerCase();
  const keywords: Record<string, string[]> = {
    "frontend-dev": ["frontend", "react", "ui", "css", "component", "page", "layout", "style", "tailwind", "html", "jsx", "tsx", "responsive", "animation", "homepage", "view"],
    "backend-dev": ["backend", "api", "server", "auth", "endpoint", "middleware", "route", "rest", "graphql", "websocket", "jwt", "oauth", "express", "fastify"],
    "devops-agent": ["docker", "dockerfile", "ci", "cd", "pipeline", "deploy", "kubernetes", "k8s", "github actions", "workflow", "nginx", "terraform", "helm", "infra"],
    "test-writer": ["test", "testing", "spec", "jest", "vitest", "playwright", "e2e", "integration test", "unit test", "coverage", "assert"],
    "database-specialist": ["database", "schema", "migration", "sql", "query", "index", "table", "postgres", "mysql", "mongodb", "orm", "prisma", "drizzle", "knex"],
  };

  // Score each candidate by counting keyword matches
  const scores: Array<{ persona: Persona; score: number }> = [];
  for (const persona of candidates) {
    const personaKeywords = keywords[persona.id] ?? [];
    const score = personaKeywords.reduce((acc, kw) => acc + (text.includes(kw) ? 1 : 0), 0);
    if (score > 0) {
      scores.push({ persona, score });
    }
  }

  if (scores.length === 0) {
    // No keyword match — caller must handle (fail-fast)
    return undefined;
  }

  // Sort by score descending, return highest. Ties broken by candidate order
  // (which is reproducible across runs since candidates is the filtered Map order).
  scores.sort((a, b) => b.score - a.score);
  return scores[0].persona;
}
