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
 * Match a task to the best persona based on keywords in the task title/description.
 * Falls back to first available non-reviewer persona.
 */
export function matchPersonaToTask(
  taskTitle: string,
  taskDescription: string | undefined,
  personas: Map<string, Persona>,
  allowedPersonas?: string[],
): Persona | undefined {
  const text = `${taskTitle} ${taskDescription ?? ""}`.toLowerCase();
  const candidates = [...personas.values()]
    .filter(p => !p.isReviewer) // Only implementation personas
    .filter(p => !allowedPersonas || allowedPersonas.includes(p.id));

  // Keyword matching — maps persona IDs to task keywords
  const keywords: Record<string, string[]> = {
    "frontend-dev": ["frontend", "react", "ui", "css", "component", "page", "layout", "style", "tailwind", "html", "jsx", "tsx", "responsive", "animation"],
    "backend-dev": ["backend", "api", "server", "auth", "endpoint", "middleware", "route", "rest", "graphql", "websocket", "jwt", "oauth"],
    "devops-agent": ["docker", "dockerfile", "ci", "cd", "pipeline", "deploy", "kubernetes", "k8s", "github actions", "workflow", "nginx", "terraform", "helm", "infra"],
    "test-writer": ["test", "testing", "spec", "jest", "vitest", "playwright", "e2e", "integration test", "unit test", "coverage", "assert"],
    "database-specialist": ["database", "schema", "migration", "sql", "query", "index", "table", "postgres", "mysql", "mongodb", "orm", "prisma", "drizzle", "knex"],
  };

  for (const persona of candidates) {
    const personaKeywords = keywords[persona.id] ?? [];
    if (personaKeywords.some(kw => text.includes(kw))) {
      return persona;
    }
  }

  // Fallback: first available
  return candidates[0];
}
