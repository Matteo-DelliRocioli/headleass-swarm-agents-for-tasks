# Headless Swarm Agents — Research & Architecture Document

> Investigation dates: 2026-03-15, 2026-03-16, 2026-03-17
> Status: Design decisions in progress, implementation not started

## Table of Contents

- [1. Vision](#1-vision)
- [2. Stack Decision](#2-stack-decision)
- [3. OpenCode — Agent Runtime](#3-opencode--agent-runtime)
- [4. Beads — Task Management](#4-beads--task-management)
- [5. Mem0 — Shared Memory](#5-mem0--shared-memory)
- [6. Evaluated & Rejected Alternatives](#6-evaluated--rejected-alternatives)
- [7. System Architecture](#7-system-architecture)
- [8. Custom Components to Build](#8-custom-components-to-build)
- [9. Risks & Mitigations](#9-risks--mitigations)
- [10. OpenAgentsControl — Control Layer Analysis](#10-openagentscontrol--control-layer-analysis)
- [11. Design Decision: Session Keying](#11-design-decision-session-keying)
- [12. Design Decision: Agent-to-Agent Communication](#12-design-decision-agent-to-agent-communication)
- [13. Design Decision: Spawn Visibility & Agent Awareness](#13-design-decision-spawn-visibility--agent-awareness)
- [14. Design Decision: OpenCode Agent Embedding Pattern](#14-design-decision-opencode-agent-embedding-pattern)
- [15. Design Decision: Docker Isolation Strategy](#15-design-decision-docker-isolation-strategy)
- [16. Design Decision: Tool Policy](#16-design-decision-tool-policy)
- [17. Design Decision: Concurrency Safety](#17-design-decision-concurrency-safety)
- [18. Patterns Adopted from OpenClaw](#18-patterns-adopted-from-openclaw)
- [19. OpenClaw Visibility Model — Complete Reference](#19-openclaw-visibility-model--complete-reference)
- [20. Design Decision: Kubernetes Deployment Strategy](#20-design-decision-kubernetes-deployment-strategy)

---

## 1. Vision

A fully autonomous, headless multi-agent swarm system where:

1. An **orchestrator agent** receives an initial prompt, decomposes it into subtasks (plan mode)
2. Each subtask is assigned to a **subagent** spawned with a persona loaded from `.md` files in a personas directory
3. Subagents **communicate** through a message bus
4. Shared **task management** via Beads with dependency tracking
5. **File locking** — only one agent can modify a file at a time
6. **Permission enforcement** — agents cannot delete `.claude` files/dirs, review agents are read-only
7. **Parallel review agents** spawn after implementation, each with different review focus
8. A **master reviewer** calculates a weighted confidence score from review results
9. Follow-up tasks feed back to the orchestrator for another loop iteration
10. **Hard loop limit** strictly enforced to prevent runaway token consumption
11. System is **fully autonomous** once launched with the initial prompt

---

## 2. Stack Decision

| Component | Tool | Version | License | Stars | Why chosen |
|---|---|---|---|---|---|
| **Agent runtime** | [OpenCode](https://github.com/anomalyco/opencode) | v1.2.26 | MIT | 122k | Headless server, typed SDK, per-agent permissions, plugin hooks, MCP, SSE streaming |
| **Task management** | [Beads](https://github.com/steveyegge/beads) | v0.60.0 | MIT | 19.1k | Purpose-built for multi-agent task coordination, atomic claims, dependency graph, MCP |
| **Shared memory** | [Mem0](https://github.com/mem0ai/mem0) | v1.0.5 | Apache 2.0 | ~50k | Native `agent_id` scoping, MCP server, graph memory, LLM dedup, battle-tested |
| **Message bus** | Custom | — | — | — | ~200 lines, Redis Streams or in-process EventEmitter |
| **File locking** | Custom | — | — | — | ~150 lines, flock-based with agent ownership |
| **Orchestrator** | Custom | — | — | — | ~500 lines, loop control, persona mapping, review aggregation |

---

## 3. OpenCode — Agent Runtime

- **Repo**: https://github.com/anomalyco/opencode
- **Docs**: https://opencode.ai/docs
- **DeepWiki**: https://deepwiki.com/anomalyco/opencode
- **Language**: TypeScript on Bun, monorepo with Turbo (20+ workspace packages)
- **Key libs**: Hono (HTTP), Drizzle ORM (SQLite), Vercel AI SDK, Solid.js (UI)

### 3.1 Headless Modes

| Mode | Command | Purpose | Source |
|---|---|---|---|
| Server | `opencode serve [--port N] [--hostname H] [--cors O]` | HTTP server only, clients connect remotely | [opencode.ai/docs/server](https://opencode.ai/docs/server) |
| Run | `opencode run <prompt>` | Single prompt, then exit (CI/CD) | [deepwiki.com/anomalyco/opencode/1](https://deepwiki.com/anomalyco/opencode/1-cli-entrypoint-and-commands) |
| SDK | `createOpencode()` / `createOpencodeClient()` | Programmatic control from Node/Bun | [opencode.ai/docs/sdk](https://opencode.ai/docs/sdk) |

Server auth: `OPENCODE_SERVER_PASSWORD` env var enables HTTP basic auth.
Default port: 4096. OpenAPI spec at `http://localhost:4096/doc`.

### 3.2 Agent Architecture

Two-tier model (source: [opencode.ai/docs/agents](https://opencode.ai/docs/agents), [deepwiki.com/anomalyco/opencode/3](https://deepwiki.com/anomalyco/opencode/3-session-and-agent-system)):

**Primary agents** (switchable via Tab):
- **Build** — Default, full-access development agent
- **Plan** — Read-only analysis agent; file edits denied, bash requires approval
- **Compaction** — (Hidden) Auto-compacts long contexts
- **Title** — (Hidden) Auto-generates session titles
- **Summary** — (Hidden) Auto-creates session summaries

**Subagents** (invoked by primary agents or via `@mention`):
- **General** — Full-access assistant for multi-step parallel tasks
- **Explore** — Read-only codebase exploration

### 3.3 Agent Loop

Core loop in `SessionPrompt.loop()` (source: [deepwiki.com/anomalyco/opencode/3](https://deepwiki.com/anomalyco/opencode/3-session-and-agent-system)):

1. Build message context from session history
2. Load agent config via `Agent.get()`
3. Collect tools from `ToolRegistry` + MCP servers
4. Call LLM via `Provider.AI.generate()`
5. Process tool calls (with permission checks)
6. Stream response parts via `Bus.emit()`
7. Store results via `Message.create()`
8. Loop continues until model returns without tool calls or hits token/step limits

### 3.4 Custom Agent Definition

**Markdown files** in `.opencode/agents/` or `~/.config/opencode/agents/` (source: [opencode.ai/docs/agents](https://opencode.ai/docs/agents)):

```markdown
---
description: Reviews code for quality
mode: subagent
model: anthropic/claude-sonnet-4-20250514
temperature: 0.1
tools:
  write: false
  edit: false
---
You are a code reviewer. Focus on code quality, potential bugs...
```

**JSON in `opencode.json`**:
```json
{
  "agent": {
    "review": {
      "description": "Reviews code for best practices",
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-20250514",
      "prompt": "{file:./prompts/review.txt}",
      "tools": { "write": false, "edit": false }
    }
  }
}
```

Config fields: `description`, `mode` (primary/subagent/all), `model`, `prompt`, `temperature`, `top_p`, `steps` (max iterations), `tools`, `permission`, `color`, `disable`, `hidden`.

Interactive creation: `opencode agent create`

### 3.5 Permission System

Three modes: `allow`, `deny`, `ask` (source: [deepwiki.com/anomalyco/opencode/5](https://deepwiki.com/anomalyco/opencode/5-tool-system-and-permissions)):

```json
{
  "permission": {
    "edit": "deny",
    "bash": {
      "*": "ask",
      "git status": "allow",
      "grep *": "allow"
    },
    "task": {
      "*": "deny",
      "code-reviewer": "ask"
    }
  }
}
```

`Permission.check()` validates every tool call. REST endpoint: `POST /api/permissions/approve`.
Plugins can enforce file-level restrictions via `tool.execute.before` hooks.

### 3.6 Event Bus

Source: [deepwiki.com/anomalyco/opencode/7](https://deepwiki.com/anomalyco/opencode/7-event-bus-and-real-time-updates)

Pub/sub via `Bus.emit()` / `Bus.subscribe()`.

**Key events**: `session.created`, `session.updated`, `session.idle`, `session.error`, `session.compacted`, `session.diff`, `session.status`, `message.created`, `message.updated`, `message.part.updated`, `message.removed`, `permission.asked`, `permission.replied`, `lsp.diagnostics`, `mcp.connected`, `tool.execute.before`, `tool.execute.after`, `file.edited`, `file.watcher.updated`, `todo.updated`, `shell.env`.

SSE endpoints:
- `GET /api/events` — global workspace events
- `GET /api/sessions/:id/events` — session-specific events

**Limitation**: Communication is parent→child via task tool, child→parent via result return. No direct agent-to-agent messaging. The bus is for system-level coordination and client notification.

### 3.7 SDK

Package: `@opencode-ai/sdk` (source: [opencode.ai/docs/sdk](https://opencode.ai/docs/sdk))

```typescript
import { createOpencode } from "@opencode-ai/sdk"
const { client } = await createOpencode({ hostname: "127.0.0.1", port: 4096 })

// Create session with specific agent
const session = await client.session.create({ body: { title: "Task 1" } })

// Send prompt
const result = await client.session.prompt({
  path: { id: session.id },
  body: {
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    parts: [{ type: "text", text: "Implement the login function" }]
  }
})

// Stream events
const events = await client.event.subscribe()
for await (const event of events.stream) {
  console.log(event.type, event.properties)
}

// List agents
const agents = await client.app.agents()

// Navigate child sessions
const children = await client.session.children({ path: { id: session.id } })

// Inject context without triggering AI response
await client.session.prompt({
  path: { id: session.id },
  body: { noReply: true, parts: [{ type: "text", text: "System context..." }] }
})

// Structured output with JSON schema
const structured = await client.session.prompt({
  path: { id: session.id },
  body: {
    parts: [{ type: "text", text: "Analyze this code" }],
    format: { type: "json_schema", schema: { /* Zod/JSON schema */ } }
  }
})
```

Additional: `session.abort()`, `session.shell()`, `session.revert()`, `client.file.read()`, `client.find.text()`, `client.find.symbols()`, `client.auth.set()`.

Auto-generated from OpenAPI 3.1 spec at `packages/sdk/openapi.json`.

### 3.8 Plugin System

Source: [opencode.ai/docs/plugins](https://opencode.ai/docs/plugins), [deepwiki.com/anomalyco/opencode/8](https://deepwiki.com/anomalyco/opencode/8-plugin-system)

```typescript
import type { Plugin } from "@opencode-ai/plugin"
export const MyPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  return {
    "tool.execute.before": async (input, output) => { /* intercept */ },
    "tool.execute.after": async (input, output) => { /* post-process */ },
    "session.idle": async (input, output) => { /* react */ },
    "shell.env": async (input, output) => { output.env.KEY = "val" },
    tool: {
      mytool: tool({ /* definition */ }),
    },
  }
}
```

Available hooks: `command.executed`, `file.edited`, `file.watcher.updated`, `installation.updated`, `lsp.client.diagnostics`, `lsp.updated`, `message.part.removed/updated`, `message.removed/updated`, `permission.asked/replied`, `server.connected`, `session.created/compacted/deleted/diff/error/idle/status/updated`, `todo.updated`, `shell.env`, `tool.execute.before/after`, `tui.prompt.append/command.execute/toast.show`, `experimental.session.compacting`.

Custom tools: `.ts`/`.js` files in `.opencode/tools/` or `~/.config/opencode/tools/`.

MCP servers: configured in `opencode.json` under `mcp` key — supports local (subprocess) and remote (HTTP+SSE with OAuth).

---

## 4. Beads — Task Management

- **Repo**: https://github.com/steveyegge/beads
- **DeepWiki**: https://deepwiki.com/steveyegge/beads
- **Language**: Go (93.4%), Python (4.1% for MCP)
- **Version**: v0.60.0 (March 12, 2026), 82 releases, 7,684 commits
- **Install**: `npm install -g @beads/bd` or `brew install beads` or `go install github.com/steveyegge/beads/cmd/bd@latest`

### 4.1 What It Is

Distributed, git-backed graph issue tracker designed explicitly for AI agents. Powered by Dolt (version-controlled SQL database). Provides persistent, structured memory for agent work planning with dependency-aware task graphs.

### 4.2 Data Model

Source: [deepwiki.com/steveyegge/beads/3](https://deepwiki.com/steveyegge/beads/3-data-model)

Core entity: **Issue** (~60 fields), identified by hash-based IDs (`bd-a1b2`) that prevent merge collisions.

**Key fields**:
- `Status`: open, in_progress, blocked, deferred, closed, pinned, hooked
- `Priority`: 0-4 (P0=critical)
- `IssueType`: bug, feature, task, epic, chore, decision, message, molecule
- `Assignee`, `Owner`, timestamps, `Description`, `AcceptanceCriteria`

**Hierarchy**: `bd-a3f8` (epic) → `bd-a3f8.1` (task) → `bd-a3f8.1.1` (sub-task)

**Dependency types**: `blocks`, `parent-child`, `conditional-blocks`, `waits-for`
**Entity relationships**: `authored-by`, `assigned-to`, `approved-by`, `attests`

**Dual-table architecture**:
- **Issues** — permanent, versioned via Dolt, synced via git remotes
- **Wisps** — ephemeral (`dolt_ignore`'d), for transient agent scratch work (types: agent, rig, role, gate, slot, message). Can be promoted to permanent issues.

### 4.3 Multi-Agent Features

Source: [deepwiki.com/steveyegge/beads](https://deepwiki.com/steveyegge/beads)

- **Hash-based IDs** prevent merge collisions in multi-agent/multi-branch workflows
- **Cross-repository federation** via `routes.jsonl` for prefix-based routing
- **Contributor/maintainer modes**: Contributors submit to separate planning repos; maintainers aggregate
- **Atomic claim**: `bd update <id> --claim` atomically sets assignee + in_progress, preventing double-assignment
- **Molecule system**: Workflow orchestrations with bonding types (sequential, parallel, conditional)
- **Agent identity fields**: `AgentState` (idle/spawning/running/working/stuck/done/stopped/dead), `RoleBead`, `HookBead`, `LastActivity` for timeout detection

### 4.4 Concurrent Access

Source: [deepwiki.com/steveyegge/beads/2](https://deepwiki.com/steveyegge/beads/2-architecture)

- **Dolt cell-level merge**: Different columns of same issue updated concurrently without conflict
- **3-way JSONL merge driver**: Custom git merge driver resolves conflicts field-by-field:
  - Scalar fields (title, description): last-write-wins by timestamp
  - Array fields (labels, deps): union merge with deduplication
  - Status: priority hierarchy (closed > in_progress > open)
  - Priority: higher priority wins (P0 > P1)
- **Circuit breaker**: 3-state protection (Closed/Open/Half-Open), 5 consecutive failures in 60s
- **Two-phase commit**: SQL transaction + Dolt commit ensures atomicity
- **Port management**: Hash-based collision fallback for multiple instances

### 4.5 CLI & API

All commands support `--json` output:

```bash
bd ready                          # List unblocked tasks
bd ready --json                   # JSON output
bd create "Title" -p 0 -t bug    # Create task
bd update bd-a1b2 --claim         # Atomically claim task
bd dep add bd-child bd-parent     # Add dependency
bd show bd-a1b2                   # View with audit trail
bd close bd-a1b2 "reason"         # Close task
bd list --json --status open      # Filtered listing
bd export                         # JSONL export
```

**MCP**: `beads-mcp` Python server exposes: `create_issue`, `update_issue`, `list_issues`, `search_issues`, `show_issue`.

**Direct SQL**: Dolt MySQL-compatible server on port 3307.

**npm**: `@beads/bd` for JavaScript/Node.js integration.

### 4.6 Storage Architecture

Source: [deepwiki.com/steveyegge/beads/2](https://deepwiki.com/steveyegge/beads/2-architecture)

Pure Dolt backend (SQLite and embedded Dolt modes removed in v0.58.0).

```
.beads/
  config.yaml          # Configuration (Viper)
  dolt/               # Dolt database (noms storage format)
  issues.jsonl        # Exported snapshot (backup/interchange)
  backup/             # Timestamped JSONL backups
  hooks/              # Git hook shims
```

Sync: Dolt git remotes (DoltHub, S3, GCS, local file://). Auto-push with 5-minute debounce.

Deployment modes: Standard (`bd init`), Stealth (`bd init --stealth`), Contributor (`bd init --contributor`), Daemon (`bd daemon start --local`).

---

## 5. Mem0 — Shared Memory

- **Repo**: https://github.com/mem0ai/mem0
- **DeepWiki**: https://deepwiki.com/mem0ai/mem0
- **Language**: Python 63.7%, TypeScript 24%
- **Version**: v1.0.5 (March 3, 2026)
- **Stars**: ~49,900
- **Contributors**: 261
- **Dependents**: 4,700+ repos
- **Created**: June 20, 2023
- **License**: Apache 2.0
- **Install**: `pip install mem0ai` (Python) or `npm install mem0ai` (TypeScript)

### 5.1 What It Is

Universal memory layer for AI agents. Extracts structured facts from conversations using an LLM, deduplicates against existing memories, stores them for future retrieval. Claims +26% accuracy vs OpenAI Memory, 91% faster, 90% fewer tokens (paper: arXiv:2504.19413).

### 5.2 Architecture

Source: [deepwiki.com/mem0ai/mem0/2](https://deepwiki.com/mem0ai/mem0/2-architecture-overview)

Three-tier:
1. **Client Layer**: Python SDK (`Memory` / `MemoryClient`), TypeScript SDK, REST API, Vercel AI SDK provider
2. **Core Memory System**: `Memory` class with factory-based component instantiation (LlmFactory, EmbedderFactory, VectorStoreFactory, GraphStoreFactory, RerankerFactory)
3. **Storage Layer**: Vector stores (mandatory), graph databases (optional), SQLite history DB (mandatory)

**Memory processing pipeline (add)**:
1. Session validation (requires ≥1 of user_id, agent_id, run_id)
2. LLM-based fact extraction from messages
3. Embedding generation for each fact
4. Similarity search against existing memories
5. LLM-based action determination: ADD / UPDATE / DELETE / NONE
6. Parallel storage to vector + graph stores
7. History logging to SQLite audit trail

**Two modes**:
- **Infer** (default): Full LLM pipeline — richer but costs tokens per `add()`
- **Direct** (`infer=False`): Bypasses LLM, stores as-is with embeddings only — faster, cheaper

### 5.3 Storage Backends

Source: [deepwiki.com/mem0ai/mem0/4](https://deepwiki.com/mem0ai/mem0/4-storage-backends)

**Vector stores (24+)**: Qdrant (default), Pinecone, ChromaDB, PGVector, FAISS, Milvus, MongoDB, Redis, Elasticsearch, Weaviate, Vespa, Supabase, DuckDB, MyScale, AstraDB, Zilliz, and more. Standard interface: `create()`, `search()`, `update()`, `delete()`, `get()`.

**Graph stores (4)**: Neo4j, Memgraph, Kuzu (embedded), AWS Neptune. Entity-relationship extraction via LLM pipeline: entity extraction → relationship establishment → conflict detection (cosine similarity threshold 0.7) → Cypher query execution.

**History DB**: SQLite audit trail — every ADD/UPDATE/DELETE event with old_memory, new_memory, timestamps, actor_id, role.

### 5.4 Multi-Agent Scoping

Source: [deepwiki.com/mem0ai/mem0/2.1](https://deepwiki.com/mem0ai/mem0/2.1-memory-class-architecture)

Four independent scoping dimensions:

| Scope | Identifier | Purpose |
|---|---|---|
| User | `user_id` | Long-term user preferences |
| Agent | `agent_id` | Agent-specific knowledge |
| App | `app_id` | Application-level config |
| Session | `run_id` | Single conversation context |

Scopes compose: `user_id="swarm-run-1"` + `agent_id="frontend-dev"` is separate from `user_id="swarm-run-1"` + `agent_id="backend-dev"`. Isolation enforced at storage layer via metadata filtering.

**Swarm integration pattern**:
```python
from mem0 import Memory
m = Memory.from_config(config)

# Each agent writes to its own scope
m.add(messages, agent_id="frontend-dev", user_id="swarm-run-1")
m.add(messages, agent_id="backend-dev", user_id="swarm-run-1")

# Agent reads only its own memories
m.search("auth implementation", agent_id="frontend-dev")

# Orchestrator reads ALL agent memories (omit agent_id filter)
m.search("auth implementation", user_id="swarm-run-1")
```

### 5.5 MCP Server

Source: [deepwiki.com/mem0ai/mem0/9](https://deepwiki.com/mem0ai/mem0/9-framework-integrations)

Built-in MCP server exposes: `add_memory`, `add_memories`, `search_memories`, `search_memory`, `get_memories`, `list_memories`, `update_memory`, `delete_memory`, `delete_all_memories`.

Deployment: Python package, Docker, or Smithery managed service.

**OpenMemory** (https://docs.mem0.ai/openmemory/overview): Local-first MCP memory server built on Mem0. Enables cross-tool memory sharing. Available at app.openmemory.dev or locally via Docker.

### 5.6 Graph Memory

Source: [deepwiki.com/mem0ai/mem0/4](https://deepwiki.com/mem0ai/mem0/4-storage-backends)

When a graph store is configured, Mem0 extracts entities and relationships:
1. Entity extraction (using `EXTRACT_ENTITIES_TOOL`)
2. Relationship establishment (using `RELATIONS_TOOL`)
3. Conflict detection via embedding similarity (threshold 0.7)
4. Deletion of outdated relationships
5. Cypher query execution to persist

Example: "Alice works at Google" → `Alice --works_at--> Google`

Graph + vector search runs concurrently via `ThreadPoolExecutor`.

### 5.7 Deduplication

Source: [deepwiki.com/mem0ai/mem0/3](https://deepwiki.com/mem0ai/mem0/3-memory-operations)

LLM-driven (not rule-based):
1. New facts embedded and searched against existing memories (cosine similarity)
2. LLM receives both new facts and candidates
3. LLM decides: ADD / UPDATE / DELETE / NONE

Catches semantic equivalence: "I'm vegetarian" = "I don't eat meat" → UPDATE, not duplicate ADD.

Custom prompts available via `custom_fact_extraction_prompt`.

### 5.8 Self-Hosted vs Platform

**Self-hosted**: `pip install mem0ai`, runs entirely local. Default: local Qdrant at `/tmp/qdrant`, SQLite history, OpenAI for LLM/embeddings. Air-gap compatible.

**Platform**: api.mem0.ai, API key auth, built-in analytics, webhooks, multi-tenancy.

### 5.9 API Surface

**Python SDK**: `Memory` (self-hosted), `MemoryClient` (platform), `AsyncMemory`, `AsyncMemoryClient`.

**TypeScript SDK**: `npm install mem0ai` — dual import: `mem0ai` (platform), `mem0ai/oss` (self-hosted).

**REST API**: `POST /v1/memories/`, `POST /v2/memories/search/`, `PUT /v1/memories/{id}/`, `DELETE /v1/memories/{id}/`, `/v1/entities/`, `/v1/exports/`.

**Framework integrations**: LangChain, CrewAI, AutoGen, Mastra, Camel AI, Vercel AI SDK, Dify, Raycast.

### 5.10 Limitations for Swarm Use

- **No tiered retrieval** (L0/L1/L2) — all memories are equal, no hot/warm/cold hierarchy
- **LLM-dependent dedup** — quality depends on LLM; no deterministic guarantees
- **No cross-agent sync primitives** — no pub/sub or event-driven memory updates between agents
- **No explicit memory budgets** per agent
- **Token cost on `add()`** — every infer-mode add costs LLM tokens; mitigate with `infer=False` for high-volume observations

---

## 6. Evaluated & Rejected Alternatives

### 6.1 OpenClaw — Multi-Agent Gateway

- **Repo**: https://github.com/openclaw/openclaw
- **DeepWiki**: https://deepwiki.com/openclaw/openclaw
- **Stars**: 247k-314k
- **License**: MIT
- **Language**: TypeScript (430k+ LOC, 50+ packages, pnpm workspace)

**What it is**: Self-hosted multi-agent AI gateway / personal assistant. Embeds Pi agents via `createAgentSession()`. Routes messages from WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Matrix, Google Chat, IRC, Teams, LINE, Mattermost, Twitch (20+ channels).

**Architecture**:
- Gateway server: multiplexed WebSocket RPC + HTTP APIs on port 18789
- Agent runtime: embedded Pi Agent (`pi-agent-core`, `pi-ai`, `pi-coding-agent`)
- Memory: SQLite + vector embeddings (`sqlite-vec`) with hybrid search
- Config: JSON5 at `~/.openclaw/openclaw.json`, Zod validation, hot reload
- Native clients: macOS menu bar, iOS, Android

**Multi-agent**: Each agent gets isolated workspace, separate session store, independent auth profiles. `sessions_*` tools for agent-to-agent communication. Sessions keyed as `agent:<id>:peer:<identifier>`.

**Why rejected**: Designed for personal assistant / messaging gateway, not collaborative coding swarms. No per-agent tool permissions (allow/deny/ask). No MCP support (Pi doesn't have it). No LSP integration for code intelligence. No structured JSON output via SDK.

**Reference material**: [Armin Ronacher on Pi](https://lucumr.pocoo.org/2026/1/31/pi/), [OpenClaw Pi docs](https://github.com/openclaw/openclaw/blob/main/docs/pi.md), [OpenClaw vs OpenCode](https://kau.sh/blog/opencode-openclaw/)

### 6.2 Pi Coding Agent

- **Repo**: https://github.com/badlogic/pi-mono
- **Website**: https://pi.dev/
- **DeepWiki**: https://deepwiki.com/badlogic/pi-mono
- **Stars**: ~24k
- **License**: MIT
- **Language**: TypeScript/Node.js
- **Version**: 0.57.0

**What it is**: Minimal terminal AI coding agent. "Primitives, not features." Only 4 core tools (read, write, edit, bash), system prompt under 1,000 tokens.

**Architecture**:
- `pi-ai`: Multi-provider LLM abstraction (20+ providers, 100+ models)
- `pi-agent-core`: Stateless agent runtime with `streamFn` transport abstraction
- `pi-coding-agent`: CLI coding agent with extensions, sessions, tools
- `pi-tui`: Terminal UI with differential rendering
- `pi-mom`: Slack bot using same infrastructure
- `pi-web-ui`: React components for browser chat
- `pi-pods`: vLLM GPU pod management

**Headless modes**: SDK (`createAgentSession()`), RPC (JSON-over-stdin/stdout), print/JSON (single-shot).

**Personas**: `.pi/SYSTEM.md`, skills, prompt templates, SDK `systemPromptOverride`.

**Multiple agents**: `SessionManager.inMemory()` for concurrent sessions.

**Why rejected**: No MCP support (not built-in). No per-agent tool permissions. No event bus for system-wide coordination. No REST API server mode. Extension hooks exist but you implement all enforcement logic. Less coding-specific infrastructure than OpenCode.

**Key strength**: Transport abstraction, multi-provider support (20+ LLMs), session branching/tree navigation.

### 6.3 claude-mem

- **Repo**: https://github.com/thedotmack/claude-mem
- **DeepWiki**: https://deepwiki.com/thedotmack/claude-mem
- **Stars**: ~35,000
- **License**: AGPL-3.0 (ragtime directory: PolyForm Noncommercial 1.0.0)
- **Version**: v10.5.5

**What it is**: Persistent memory/compression plugin for Claude Code. Auto-captures tool usage observations, compresses with AI, injects relevant context into future sessions.

**Architecture**: 5 lifecycle hooks → HTTP worker service (port 37777) → processing pipeline → SQLite3 + FTS5 + ChromaDB. MCP server via stdio-based JSON-RPC. Web UI at `http://localhost:37777`.

**Why rejected**:
- **AGPL-3.0 license** — derivative works must share source if deployed on a network
- **No multi-agent isolation** — no per-agent namespacing; all agents see all observations
- **Single-port binding** (37777) — unclear how multiple instances coexist
- **Context pollution risk** — high when multiple agents share same project
- **No concurrent write safety** — shared SQLite, no documented multi-writer locking

### 6.4 OpenViking

- **Repo**: https://github.com/volcengine/OpenViking
- **DeepWiki**: https://deepwiki.com/volcengine/OpenViking
- **Stars**: 11.3k
- **License**: Apache 2.0

**What it is**: Context database for AI agents by ByteDance's Volcano Engine Viking Team. Virtual filesystem via `viking://` URI protocol. Three-tier information model: L0 (~100 tokens), L1 (~2000 tokens), L2 (full content).

**Strengths**:
- Multi-agent space isolation via `viking://agent/{agent_space}/`
- L0/L1/L2 tiered retrieval for token efficiency
- Multi-backend: C++ embedded vector DB, S3, memfs, localfs
- Backed by VikingDB (in production since 2019)

**Why rejected**:
- **Zero MCP integration** — would need custom MCP wrapper (~200+ lines)
- **Only 2 months old** as open source (alpha quality)
- **No TypeScript SDK** — Python + Rust CLI only
- **Heavyweight** — requires C++ compilation, Go for AGFS
- **Smaller ecosystem** — 11k stars vs Mem0's 50k

### 6.5 Custom Build (from scratch)

**Why rejected**: Building atop raw Claude Agent SDK or LLM APIs would require implementing: agent lifecycle management, tool routing, permission system, session management, context windowing, prompt engineering, streaming, error recovery — all from scratch. Only justified if OpenCode's architecture fundamentally conflicts with the design.

---

## 7. System Architecture

### 7.1 Component Diagram

```
┌─────────────────────────────────────────────────────┐
│                SWARM ORCHESTRATOR                     │
│  (Custom TypeScript layer on OpenCode SDK)           │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Loop      │  │ Task     │  │ Agent Spawner    │  │
│  │ Controller│  │ Router   │  │ (persona loader) │  │
│  │ (max N)   │  │          │  │                  │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│                       │                              │
│  ┌────────────────────┼──────────────────────────┐  │
│  │           MESSAGE BUS (custom)                 │  │
│  │    Redis Streams / in-process EventEmitter     │  │
│  └────────────────────┼──────────────────────────┘  │
│                       │                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ File Lock │  │ Beads    │  │ Mem0             │  │
│  │ Manager   │  │ (tasks)  │  │ (scoped memory)  │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────┘
         │              │              │
    ┌────┴────┐   ┌────┴────┐   ┌────┴────┐
    │OpenCode │   │OpenCode │   │OpenCode │
    │Session 1│   │Session 2│   │Session N│
    │(persona)│   │(persona)│   │(persona)│
    └─────────┘   └─────────┘   └─────────┘
```

### 7.2 Phase 1: Task Decomposition

```
User prompt → Orchestrator Agent (Plan mode)
    ├── Decomposes into subtasks via Beads
    │   bd create "Epic: {user prompt}" -t epic
    │   bd create "Subtask 1" -t task --parent bd-epic
    │   bd create "Subtask 2" -t task --parent bd-epic
    │   bd dep add bd-sub2 bd-sub1  (sub2 blocks on sub1)
    │
    ├── Maps each subtask → persona from /personas/*.md
    │   Reads persona descriptions, matches to task requirements
    │
    └── Writes shared context to Mem0
        m.add(context, agent_id="orchestrator", user_id="swarm-run-1")
```

### 7.3 Phase 2: Implementation

```
For each ready task (bd ready --json):
    Orchestrator:
    ├── Spawns OpenCode session with matched persona
    │   client.session.create({ agentID: "frontend-dev" })
    │
    ├── Agent claims task
    │   bd update bd-sub1 --claim
    │
    ├── Agent works (with file lock enforcement)
    │   Plugin hook: tool.execute.before → check lock manager
    │   If file locked by another agent → wait/skip
    │   If file free → acquire lock → proceed
    │
    ├── Agent writes progress to own Mem0 scope
    │   m.add(decisions, agent_id="frontend-dev", user_id="swarm-run-1")
    │
    ├── Agent communicates via message bus
    │   Bus: "I need the API interface from backend-dev"
    │   → Routed to backend-dev agent or queued
    │
    └── Agent closes task on completion
        bd close bd-sub1 "Completed" --json
```

### 7.4 Phase 3: Parallel Review

```
All implementation tasks closed →
    Orchestrator spawns N review agents in parallel:
    ├── Review Agent 1 (code quality persona)
    │   tools: { write: false, edit: false, bash: "deny" }
    │   Reads all changed files
    │   Outputs JSON: { score: 0.85, issues: [...] }
    │
    ├── Review Agent 2 (security persona)
    │   Same read-only config
    │   Outputs JSON: { score: 0.92, issues: [...] }
    │
    └── Review Agent 3 (architecture persona)
        Same read-only config
        Outputs JSON: { score: 0.78, issues: [...] }
```

### 7.5 Phase 4: Confidence Scoring

```
Master Reviewer Agent:
    ├── Collects all review JSONs
    ├── Weighted confidence: Σ(weight_i × score_i) / Σ(weight_i)
    │   Where weights are per-review-type (security > style)
    ├── Consensus filtering: issues flagged by ≥2 reviewers get higher confidence
    ├── Outputs:
    │   { confidence: 0.84,
    │     follow_up_tasks: [
    │       { title: "Fix SQL injection in auth.ts:42", priority: 0 },
    │       { title: "Add error handling for edge case X", priority: 2 }
    │     ] }
    └── Creates follow-up tasks in Beads
        bd create "Fix SQL injection" -p 0 --parent bd-epic
```

### 7.6 Phase 5: Loop Control (STRICTLY enforced)

```typescript
const MAX_LOOPS = 3 // Hard limit, configurable
let currentLoop = 0

while (currentLoop < MAX_LOOPS) {
  currentLoop++
  log(`=== LOOP ${currentLoop}/${MAX_LOOPS} ===`)

  const result = await executeLoop(beads, opencode, mem0)

  if (result.confidence >= CONFIDENCE_THRESHOLD) {
    log("Confidence threshold met. Stopping.")
    break
  }

  if (result.followUpTasks.length === 0) {
    log("No follow-up tasks. Stopping.")
    break
  }

  if (currentLoop === MAX_LOOPS) {
    log("MAX LOOPS REACHED. HARD STOP.")
    // Write remaining tasks to Beads for manual review
    await beads.createBatch(result.followUpTasks, { status: "deferred" })
    break
  }
}
```

---

## 8. Custom Components to Build

### 8.1 File Lock Manager (~150 lines)

```typescript
class FileLockManager {
  private locks = new Map<string, { agentId: string; fd: number }>()

  async acquire(filePath: string, agentId: string): Promise<boolean> {
    if (this.locks.has(filePath)) {
      return false
    }
    const fd = fs.openSync(filePath + '.lock', 'w')
    try {
      flock(fd, LOCK_EX | LOCK_NB)
      this.locks.set(filePath, { agentId, fd })
      return true
    } catch {
      fs.closeSync(fd)
      return false
    }
  }

  release(filePath: string, agentId: string): void {
    const lock = this.locks.get(filePath)
    if (lock?.agentId === agentId) {
      flock(lock.fd, LOCK_UN)
      fs.closeSync(lock.fd)
      fs.unlinkSync(filePath + '.lock')
      this.locks.delete(filePath)
    }
  }
}
```

### 8.2 Swarm Guard Plugin (~100 lines)

```typescript
export const SwarmGuard: Plugin = async ({ project }) => ({
  "tool.execute.before": async (input, output) => {
    const { tool, args } = input

    // Rule 1: Never delete/modify .claude files/dirs
    if (['write', 'edit', 'bash'].includes(tool)) {
      const path = args.file_path || args.command || ''
      if (path.includes('.claude')) {
        output.deny("Cannot modify .claude files/directories")
        return
      }
    }

    // Rule 2: File locking
    if (['write', 'edit'].includes(tool) && args.file_path) {
      const acquired = await lockManager.acquire(args.file_path, input.agentId)
      if (!acquired) {
        output.deny(`File ${args.file_path} is locked by another agent`)
        return
      }
    }
  },

  "tool.execute.after": async (input, output) => {
    if (['write', 'edit'].includes(input.tool) && input.args.file_path) {
      lockManager.release(input.args.file_path, input.agentId)
    }
  }
})
```

### 8.3 Message Bus (~200 lines)

Redis Streams for durable inter-agent messaging, or in-process `EventEmitter` for simpler setups. Routes messages between OpenCode sessions.

### 8.4 Orchestrator (~500 lines)

Uses OpenCode SDK to: create sessions, assign agents, enforce loop limits, aggregate reviews, calculate confidence scores, map personas to tasks.

### 8.5 Persona Loader (~50 lines)

Reads `.md` files from personas directory, maps to OpenCode agent configs.

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Runaway token consumption | Hard MAX_LOOPS + per-agent `steps` limit in OpenCode config + Beads circuit breaker |
| Agents editing same file | File lock manager + OpenCode plugin hook enforcement |
| Context pollution in memory | Mem0 native `agent_id` scoping; orchestrator queries across all |
| Agent deadlock (all waiting for locks) | Timeout on lock acquisition + orchestrator deadlock detection |
| Beads Dolt conflicts | Cell-level merge + 3-way JSONL merge driver handles most cases |
| OpenCode server crash | PID tracking + auto-restart in orchestrator |
| Infinite follow-up tasks | MAX_LOOPS hard stop; deferred tasks to Beads for human review |
| Mem0 LLM token cost on add() | Use `infer=False` (direct mode) for high-volume observations; `infer=True` for decisions |
| OpenViking alternative if Mem0 insufficient | OpenViking has better tiered retrieval but no MCP; could add as secondary store |

---

## 10. OpenAgentsControl — Control Layer Analysis

- **Repo**: https://github.com/darrenhinde/OpenAgentsControl
- **DeepWiki**: https://deepwiki.com/darrenhinde/OpenAgentsControl
- **Stars**: 2,727
- **License**: MIT
- **Version**: v0.7.1 (2026-01-30)
- **Language**: TypeScript (1.5MB), Shell (371KB)
- **Built for**: OpenCode CLI specifically

### 10.1 What It Is

A registry-driven AI agent framework for plan-first development workflows with approval-based execution. Contains 60+ components: 12 agents, 16 subagents, 15 commands, 2 tools, 3 plugins, and 70+ context files.

### 10.2 Three-Tier Agent Hierarchy (The "Control Layer")

**Tier 1 — Primary Agents** (`mode: primary`): User-facing orchestrators that can delegate.
- **OpenAgent**: Universal coordinator using 6-stage workflow (Discover→Propose→Approve→Execute→Validate→Ship)
- **OpenCoder**: Development specialist
- **SystemBuilder**: Meta-level generator for creating custom AI systems

**Tier 2 — Subagents** (`mode: subagent`): Specialized executors that CANNOT delegate further.
- TaskManager, ContextScout, CoderAgent, TestEngineer, CodeReviewer, BuildAgent, DocWriter, ExternalScout
- Category specialists: frontend, devops, copywriter, data-analyst

**Tier 3 — Tools**: read, write, edit, bash, task (delegation), grep, glob, plus custom tools

The `mode` attribute enforced at runtime prevents infinite delegation loops — subagents are denied access to the `task` tool.

Source: [deepwiki.com/darrenhinde/OpenAgentsControl](https://deepwiki.com/darrenhinde/OpenAgentsControl)

### 10.3 6-Stage Workflow

1. **Discover** — ContextScout finds relevant patterns (ranked Critical/High/Medium)
2. **Propose** — Agent generates a detailed plan
3. **Approve** — Human review gate (mandatory)
4. **Execute** — Incremental implementation
5. **Validate** — Tests, type checking, code review
6. **Ship** — Production-ready deployment

### 10.4 Quality Checking Model

Quality checking is **hierarchical, not peer-to-peer**:
- Primary agents delegate to **CodeReviewer** subagent for security reviews
- **TestEngineer** subagent handles test validation
- **BuildAgent** validates builds
- 11 evaluators (7 static + 4 dynamic) validate agent behavior via golden test suite

### 10.5 Web UI / Dashboard

**No real-time web dashboard exists.** Only a post-hoc evaluation results viewer:
- `npm run dashboard` serves `evals/results/index.html`
- Shows pass/fail metrics from golden tests
- Not a live operational dashboard for monitoring running agents

### 10.6 Assessment for Our Swarm

**What to adopt (patterns, not the framework)**:

| OAC Pattern | Our Adaptation |
|---|---|
| Three-tier hierarchy with mode enforcement | Use for our orchestrator→implementation→review hierarchy |
| `mode: subagent` prevents infinite delegation | Enforce via OpenCode agent config: subagents get `task` tool denied |
| Registry-based agent component system | Our `/personas/*.md` directory serves the same purpose |
| 6-stage workflow | Adapt to: Plan→Assign→Execute→Review→Score→Loop |
| Context files with MVI principle (~750 tokens) | Apply to persona definitions — keep under 200 lines |
| Golden test suite for agent validation | Build evaluation suite for our swarm agents |

**What NOT to adopt**:
- **Human approval gates** — conflicts with fully autonomous requirement
- **The framework itself** — tightly coupled to OpenCode CLI, pre-1.0, no standalone SDK
- **Static evaluation dashboard** — we need a real-time web UI (build custom or use existing monitoring)

**Control layer UI we need to build**:
A real-time web dashboard showing:
- Active agents and their current task (from Beads)
- Agent status (idle/working/reviewing/blocked)
- File lock state (who owns what)
- Loop progress (current loop N of MAX_LOOPS)
- Review scores and confidence trending
- Message bus activity
- Token consumption per agent

This could be a simple SSE-powered web page consuming OpenCode's `GET /api/events` + Beads `bd list --json` + custom orchestrator state.

---

## 11. Design Decision: Session Keying

**Decision**: Adopt OpenClaw's hierarchical namespace pattern for all agent session identification.

### 11.1 Session Key Format

```
agent:<agentId>:<context>
```

**Our namespace scheme**:

| Pattern | Example | Purpose |
|---|---|---|
| `agent:orchestrator:main` | — | Main orchestrator session |
| `agent:orchestrator:plan:loop-{N}` | `agent:orchestrator:plan:loop-1` | Planning phase per loop |
| `agent:{persona}:task:{beads-id}` | `agent:frontend-dev:task:ksw.3` | Implementation agent working on a Beads task |
| `agent:{persona}:review:{loop-N}` | `agent:reviewer-security:review:loop-1` | Review agent for a specific loop |
| `agent:master-reviewer:aggregate:{loop-N}` | `agent:master-reviewer:aggregate:loop-1` | Master reviewer aggregation |

### 11.2 Key Properties

- **Parseable**: Split on `:`, `parts[0]` = "agent", `parts[1]` = agentId, `parts[2:]` = context
- **Composable**: Context segments can encode task ID, loop number, phase
- **Debuggable**: Human-readable, greppable in logs
- **Unique**: No two agents share a session key (persona + task ID ensures uniqueness)
- **Namespace isolation**: All state (sessions, memory, locks, messages) keys off this

### 11.3 Implementation

```typescript
// Inspired by openclaw/src/sessions/session-key-utils.ts
interface ParsedSessionKey {
  agentId: string;
  context: string;
}

function parseSessionKey(key: string): ParsedSessionKey | null {
  const parts = key.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") return null;
  return { agentId: parts[1], context: parts.slice(2).join(":") };
}

function buildSessionKey(agentId: string, ...context: string[]): string {
  return `agent:${agentId}:${context.join(":")}`;
}

// Usage
buildSessionKey("frontend-dev", "task", "ksw.3")
// → "agent:frontend-dev:task:ksw.3"
```

Source pattern: [openclaw/src/sessions/session-key-utils.ts:1-32](https://github.com/openclaw/openclaw), [openclaw/src/routing/session-key.ts:118-174](https://github.com/openclaw/openclaw)

---

## 12. Design Decision: Agent-to-Agent Communication

**Decision**: Use **tool calls** as the primary communication mechanism, not a separate message bus.

### 12.1 Analysis: Bus vs Tool Calls

| Dimension | Message Bus (Redis Streams / EventEmitter) | Tool Calls (OpenClaw `sessions_send` pattern) |
|---|---|---|
| **Architecture** | Separate infrastructure, pub/sub model | LLM decides when to communicate via tool call |
| **Agent autonomy** | Agent must poll or subscribe | Agent decides at inference time what/when/to whom |
| **Durability** | Durable (Redis persists) | Depends on implementation (can be durable) |
| **Complexity** | ~200 lines + Redis dependency | ~100 lines, no external dependency |
| **Coupling** | Loose (producer doesn't know consumer) | Direct (sender names the target) |
| **Proven at scale** | Standard infrastructure pattern | OpenClaw: 247k+ stars, production use |
| **Token cost** | Zero (out-of-band) | Each message costs tool call tokens |
| **Async delivery** | Natural (messages queue) | Requires queue if target is busy |

### 12.2 Why Tool Calls Win for Our Case

1. **Our agents don't need peer-to-peer chat.** The orchestrator manages flow. Agents work on tasks, report results. The rare case of "I need info from another agent" can go through:
   - **Shared memory (Mem0)**: Agent A writes a decision → Agent B reads it via `search_memories`
   - **Shared files**: Agent A writes an API interface → Agent B reads the file
   - **Beads task metadata**: Agent A updates task with notes → Agent B reads via `bd show`

2. **Tool calls let the LLM decide.** The agent naturally determines when communication is needed, what to say, and to whom. No polling loop.

3. **OpenClaw proves it works at scale.** Their `sessions_send` tool is the primary inter-agent communication mechanism for 247k+ star production use.

4. **Less infrastructure.** No Redis dependency. No subscription management.

### 12.3 Our `swarm_send` Tool Design

Register as an OpenCode custom tool (`.opencode/tools/swarm-send.ts`):

```typescript
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Send a message to another agent in the swarm. Use for coordination, questions, or status updates.",
  args: {
    targetAgent: tool.schema.string().describe("Target agent ID (e.g., 'backend-dev', 'orchestrator')"),
    message: tool.schema.string().describe("Message content"),
    priority: tool.schema.enum(["normal", "urgent"]).optional().describe("Message priority"),
  },
  async execute(args, context) {
    // Route through orchestrator's message queue
    const sessionKey = buildSessionKey(args.targetAgent, "inbox")
    await messageQueue.enqueue({
      from: context.agentId,
      to: args.targetAgent,
      message: args.message,
      priority: args.priority ?? "normal",
      timestamp: Date.now(),
    })
    return `Message sent to ${args.targetAgent}`
  },
})
```

### 12.4 When We Still Use a Queue

The orchestrator maintains an in-process message queue (no Redis needed) for:
- **Delivery when target is busy**: Messages queue until the agent's next prompt cycle
- **Idempotency**: Deduplication via message ID (inspired by OpenClaw's `idempotencyKey` pattern)
- **Audit trail**: All messages logged for debugging

```typescript
// In-process message queue (no external dependency)
class SwarmMessageQueue {
  private queues = new Map<string, Message[]>()
  private delivered = new Set<string>() // Idempotency

  enqueue(msg: Message): void {
    const key = `${msg.from}:${msg.to}:${msg.timestamp}`
    if (this.delivered.has(key)) return // Dedup
    const queue = this.queues.get(msg.to) ?? []
    queue.push(msg)
    this.queues.set(msg.to, queue)
  }

  drain(agentId: string): Message[] {
    const msgs = this.queues.get(agentId) ?? []
    this.queues.delete(agentId)
    msgs.forEach(m => this.delivered.add(`${m.from}:${m.to}:${m.timestamp}`))
    return msgs
  }
}
```

Source inspiration: [openclaw/src/agents/tools/sessions-send-tool.ts:27-76](https://github.com/openclaw/openclaw), [openclaw/src/gateway/server-methods/send.ts:34-46](https://github.com/openclaw/openclaw)

---

## 13. Design Decision: Spawn Visibility & Agent Awareness

**Decision**: Agents SHOULD know about their siblings. Scoped visibility, not full isolation.

### 13.1 Why Not Full Isolation (OpenClaw's Default)

OpenClaw's `spawnedBy` model restricts child sessions to only see their own children. This makes sense for OpenClaw because:
- Agents handle different users on different channels (privacy boundary)
- Sandboxed agents run untrusted code (security boundary)

**Our case is different**:
- All agents work on the **same codebase** toward the **same goal**
- Agents need to know what others are working on to **avoid conflicts**
- Review agents need to see ALL implementation agents' work
- There's no privacy/security boundary between our agents

### 13.2 Our Visibility Model

Three visibility tiers:

| Agent Type | Can See | Can Modify | Rationale |
|---|---|---|---|
| **Orchestrator** | All agents, all sessions, all tasks | Everything | Central control plane |
| **Implementation agents** | Sibling roster (who's working on what), Beads tasks, shared memory | Own task scope only, own Mem0 scope | Need coordination awareness, limited blast radius |
| **Review agents** | All implementation results, all changed files, all tasks | Nothing (read-only) | Need full picture for review |
| **Master reviewer** | All review results, all tasks | Only Beads (to create follow-up tasks) | Aggregation and task creation only |

### 13.3 Implementation: Agent Roster

The orchestrator injects a **roster** into each agent's context at spawn time:

```typescript
// Inject as system context when spawning an implementation agent
const roster = await beads.list({ status: "in_progress", json: true })
const rosterContext = roster.map(t =>
  `- ${t.assignee} is working on "${t.title}" (${t.id})`
).join("\n")

await client.session.prompt({
  path: { id: session.id },
  body: {
    noReply: true, // Context injection, not a prompt
    parts: [{ type: "text", text: `## Active Agents\n${rosterContext}` }]
  }
})
```

Agents can query the roster via Beads: `bd list --status in_progress --json`

### 13.4 What Agents Check About Each Other

Using OAC's pattern of hierarchical quality checking, but adapted:

- **During implementation**: Agents check Beads for task dependencies. If a dependency is in_progress, they can read the other agent's committed files but cannot modify them (file locking enforces this).
- **During review**: Review agents see all changed files and all Mem0 memories across all agent scopes (`user_id` filter only, no `agent_id` filter).
- **Quality oversight**: The orchestrator periodically checks agent status via `AgentState` in Beads. If an agent is `stuck` (no activity for N minutes), the orchestrator can abort and reassign.

---

## 14. Design Decision: OpenCode Agent Embedding Pattern

**Decision**: Use OpenCode's HTTP server + SDK, NOT in-process embedding.

### 14.1 OpenClaw's Approach vs Ours

OpenClaw imports Pi's `createAgentSession()` directly — the agent loop runs in-process. They do this because Pi is a library designed for embedding.

**OpenCode is different**. It's designed as a server:
- `opencode serve` runs a headless HTTP server with REST API + SSE
- `@opencode-ai/sdk` provides a typed TypeScript client
- The server manages its own state, sessions, LSP, plugins

### 14.2 Our Approach: SDK-Driven Orchestration

```typescript
import { createOpencode } from "@opencode-ai/sdk"

// Connect to OpenCode server (started separately or by orchestrator)
const { client } = await createOpencode({ hostname: "127.0.0.1", port: 4096 })

// Spawn an agent with persona
async function spawnAgent(persona: string, task: BeadsTask): Promise<string> {
  // Create session targeting the persona's agent definition
  const session = await client.session.create({
    body: { title: `${persona}:${task.id}` }
  })

  // Inject persona context + task + roster
  await client.session.prompt({
    path: { id: session.id },
    body: {
      noReply: true,
      parts: [{ type: "text", text: buildAgentContext(persona, task) }]
    }
  })

  // Send the actual task prompt
  await client.session.prompt({
    path: { id: session.id },
    body: {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
      parts: [{ type: "text", text: task.description }]
    }
  })

  return session.id
}
```

### 14.3 Why This Is Better for Us

| Aspect | In-Process (Pi/OpenClaw) | Server + SDK (OpenCode) |
|---|---|---|
| Agent isolation | Shared process, shared memory | Separate sessions, server-managed |
| Crash recovery | Agent crash kills orchestrator | Agent crash = failed session, orchestrator retries |
| Plugin hooks | Must inject at code level | Server-side plugins loaded from `.opencode/plugins/` |
| Tool management | Must construct tool arrays | Server manages tool registry + MCP |
| LSP integration | Manual | Server provides built-in |
| Scaling | Limited by single process | Multiple server instances possible |

### 14.4 Custom Tools Injection

Instead of injecting tools at code level like OpenClaw, we use OpenCode's custom tool system:

```
.opencode/tools/
├── swarm-send.ts        # Agent-to-agent messaging
├── swarm-status.ts      # Query swarm state
├── beads-claim.ts       # Claim a Beads task
├── beads-close.ts       # Close a Beads task
└── beads-ready.ts       # List ready tasks
```

Plus MCP servers for Beads (`beads-mcp`) and Mem0 (built-in MCP server).

---

## 15. Design Decision: Docker Isolation Strategy (Local Dev)

**Decision**: Single Docker Compose stack with sibling containers for local dev, NOT nested Docker. See [Section 20](#20-design-decision-kubernetes-deployment-strategy) for Kubernetes production deployment.

### 15.1 Why Not Docker-in-Docker (DinD)

Docker-in-Docker is fragile:
- Requires `--privileged` flag (security risk)
- Inner Docker daemons have storage driver conflicts
- Layer caching doesn't work across inner/outer
- Debugging is painful (which Docker daemon?)
- Resource limits don't compose well

### 15.2 Our Docker Architecture

```yaml
# docker-compose.yml
services:
  orchestrator:
    build: ./orchestrator
    volumes:
      - workspace:/workspace
      - ./personas:/personas:ro
    depends_on: [opencode, beads, mem0]

  opencode:
    image: opencode:latest
    command: serve --port 4096 --hostname 0.0.0.0
    volumes:
      - workspace:/workspace
      - ./opencode-config:/root/.config/opencode
    ports: ["4096:4096"]

  beads:
    image: beads:latest
    command: daemon start --local
    volumes:
      - workspace:/workspace
      - beads-data:/root/.beads

  mem0:
    image: mem0:latest
    volumes:
      - mem0-data:/data
    ports: ["8080:8080"]

  mem0-qdrant:
    image: qdrant/qdrant:latest
    volumes:
      - qdrant-data:/qdrant/storage

  dashboard:
    build: ./dashboard
    ports: ["3000:3000"]
    depends_on: [orchestrator, opencode, beads]

volumes:
  workspace:
  beads-data:
  mem0-data:
  qdrant-data:
```

### 15.3 Agent Isolation Without Nested Docker

Each OpenCode agent runs as a **separate session** within the same OpenCode server, not a separate container. Isolation is enforced via:

1. **File locking** — one agent per file at a time
2. **OpenCode permissions** — per-agent tool allow/deny
3. **Swarm Guard plugin** — blocks `.claude` modifications, enforces locks
4. **Beads atomic claim** — prevents double-assignment

If stronger isolation is needed later (e.g., untrusted agent code execution), we can add Docker sandbox containers using OpenClaw's pattern — but as **sibling containers** (orchestrator uses Docker API to create them), NOT nested Docker.

---

## 16. Design Decision: Tool Policy

**Decision**: Use OpenCode's native per-agent permissions, supplemented by our Swarm Guard plugin.

### 16.1 Why Not OpenClaw's Glob Pattern System

OpenClaw uses glob-based allow/deny lists (`sandbox/tool-policy.ts:35-109`):
```typescript
// OpenClaw pattern
tools: { allow: ["read", "grep", "glob"], deny: ["bash:rm *"] }
```

OpenCode already has a **more granular system** built-in:
```json
{
  "permission": {
    "edit": "deny",
    "bash": { "*": "ask", "git status": "allow" },
    "task": { "*": "deny", "code-reviewer": "ask" }
  }
}
```

Source: [opencode.ai/docs/agents](https://opencode.ai/docs/agents), [deepwiki.com/anomalyco/opencode/5](https://deepwiki.com/anomalyco/opencode/5-tool-system-and-permissions)

### 16.2 Our Permission Matrix

| Agent Type | read | write | edit | bash | task | MCP (Beads) | MCP (Mem0) |
|---|---|---|---|---|---|---|---|
| **Orchestrator** | allow | allow | allow | allow | allow | allow | allow |
| **Implementation** | allow | allow | allow | allow (restricted) | deny | allow | allow (own scope) |
| **Review** | allow | **deny** | **deny** | **deny** | deny | allow (read) | allow (read) |
| **Master Reviewer** | allow | **deny** | **deny** | **deny** | deny | allow (create tasks) | allow (read all) |

### 16.3 Swarm Guard Plugin (Supplementary)

The OpenCode plugin adds rules that can't be expressed in static config:

```typescript
// Additional dynamic rules beyond static permissions:
// 1. .claude file/dir protection (path-based, not tool-based)
// 2. File locking enforcement (requires runtime state)
// 3. Agent-specific path restrictions (implementation agents limited to their task's scope)
```

Source pattern: [openclaw/src/agents/sandbox/tool-policy.ts:35-109](https://github.com/openclaw/openclaw)

---

## 17. Design Decision: Concurrency Safety

**Decision**: Implement three concurrency mechanisms inspired by OpenClaw.

### 17.1 Session Write Locks

Prevents concurrent mutations to the same OpenCode session. Adapted from OpenClaw's `session-write-lock.ts`.

```typescript
// Per-session file lock (reentrant, with stale detection)
class SessionWriteLock {
  private locks = new Map<string, { count: number; fd: number; pid: number }>()

  async acquire(sessionId: string, timeoutMs = 10_000): Promise<{ release: () => void }> {
    const lockFile = `.swarm/locks/session-${sessionId}.lock`
    const held = this.locks.get(sessionId)

    // Reentrant: same process can acquire multiple times
    if (held) {
      held.count++
      return { release: () => this.release(sessionId) }
    }

    // Acquire with timeout
    const fd = await acquireFileLock(lockFile, timeoutMs)
    this.locks.set(sessionId, { count: 1, fd, pid: process.pid })
    return { release: () => this.release(sessionId) }
  }

  private release(sessionId: string): void {
    const held = this.locks.get(sessionId)
    if (!held) return
    held.count--
    if (held.count === 0) {
      releaseFileLock(held.fd)
      this.locks.delete(sessionId)
    }
  }
}
```

Key properties (from OpenClaw `openclaw/src/agents/session-write-lock.ts:444-553`):
- **Reentrant**: Reference-counted, same process can acquire multiple times
- **Stale detection**: PID-aware, detects dead processes holding locks
- **Watchdog**: Cleanup runs every 60 seconds
- **Max hold**: 5 minutes default (prevents zombie locks)
- **Stale timeout**: 30 minutes default

### 17.2 File-Level Locks

Already documented in section 8.1. Key addition: stale lock detection (from OpenClaw pattern).

### 17.3 Request Idempotency / Message Deduplication

Prevents duplicate message delivery in the swarm message queue. Adapted from OpenClaw's gateway deduplication (`openclaw/src/gateway/server-methods/send.ts:34-46`).

```typescript
class IdempotencyCache {
  private cache = new Map<string, { result: any; expiry: number }>()

  has(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false
    if (Date.now() > entry.expiry) {
      this.cache.delete(key)
      return false
    }
    return true
  }

  set(key: string, result: any, ttlMs = 300_000): void {
    this.cache.set(key, { result, expiry: Date.now() + ttlMs })
  }

  get(key: string): any | undefined {
    return this.has(key) ? this.cache.get(key)!.result : undefined
  }

  // Periodic cleanup
  prune(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (now > entry.expiry) this.cache.delete(key)
    }
  }
}
```

Used in the swarm message queue:
```typescript
async function handleMessage(msg: SwarmMessage): Promise<void> {
  const dedupeKey = `${msg.from}:${msg.to}:${msg.id}`
  if (idempotencyCache.has(dedupeKey)) return // Already processed
  await deliverMessage(msg)
  idempotencyCache.set(dedupeKey, { delivered: true })
}
```

Source pattern: [openclaw/src/gateway/server-methods/send.ts:34-46](https://github.com/openclaw/openclaw)

---

## 18. Patterns Adopted from OpenClaw

Updated and validated table of patterns we're borrowing from OpenClaw:

| Pattern | OpenClaw Implementation | Our Adaptation | Status |
|---|---|---|---|
| **Hierarchical session keys** | `agent:<id>:<context>` | Same format. See [Section 11](#11-design-decision-session-keying). | Adopted |
| **Agent-to-agent via tool calls** | `sessions_send` tool | Custom `swarm_send` OpenCode tool + in-process message queue. See [Section 12](#12-design-decision-agent-to-agent-communication). | Adopted (modified) |
| **Spawn visibility scoping** | `spawnedBy` filter, restricted by default | **Inverted**: agents see siblings by default via roster injection + Beads queries. See [Section 13](#13-design-decision-spawn-visibility--agent-awareness). | Adopted (inverted) |
| **Agent embedding** | Direct `createAgentSession()` import with tool injection | SDK-driven via `opencode serve` + `@opencode-ai/sdk`. See [Section 14](#14-design-decision-opencode-agent-embedding-pattern). | Different approach |
| **Docker sandbox** | Per non-main session | Single Docker Compose stack, sibling containers. See [Section 15](#15-design-decision-docker-isolation-strategy). | Adapted |
| **Tool policy** | Glob-based allow/deny lists | OpenCode native per-agent permissions + Swarm Guard plugin. See [Section 16](#16-design-decision-tool-policy). | OpenCode native |
| **Session write locks** | Per-session-file, reentrant, stale-aware | Adopted + extended to file-level locks. See [Section 17](#17-design-decision-concurrency-safety). | Adopted |
| **Idempotency deduplication** | WeakMap cache with idempotency keys | TTL-based cache in swarm message queue. See [Section 17](#17-design-decision-concurrency-safety). | Adopted |
| **`spawnedBy` immutability** | Cannot change/clear once set | Track parent→child in orchestrator state; immutable once spawned. | Adopted |
| **Control layer hierarchy** | (From OAC) Three-tier with mode enforcement | Orchestrator→Implementation→Review with denied `task` tool for subagents. See [Section 10](#10-openagentscontrol--control-layer-analysis). | Adopted from OAC |

---

## 19. OpenClaw Visibility Model — Complete Reference

Documented here for reference since our visibility model (Section 13) intentionally differs.

### 19.1 Visibility Decision Tree

```
isResolvedSessionVisibleToRequester(requester, target, restrictToSpawned, resolvedViaSessionId)
  │
  ├─ shouldVerifyRequesterSpawnedSessionVisibility():
  │  ├─ if (restrictToSpawned && !resolvedViaSessionId && requester != target)
  │  │  └─ Continue to spawn check
  │  └─ else
  │     └─ RETURN TRUE (always visible)
  │
  └─ isRequesterSpawnedSessionVisible():
     ├─ if (requester == target) → RETURN TRUE
     └─ Query: sessions.list(spawnedBy=requesterSessionKey)
        ├─ if (target found) → RETURN TRUE
        └─ else → RETURN FALSE
```

Source: `openclaw/src/agents/tools/sessions-resolution.ts:79-114`

### 19.2 Visibility Levels

| Level | Scope | Description |
|---|---|---|
| `"self"` | Current session only | Most restrictive |
| `"tree"` | Current + spawned children | Default for sandboxed |
| `"agent"` | All sessions of same agent | Default for non-sandboxed |
| `"all"` | Cross-agent (if a2a policy permits) | Requires explicit config |

Source: `openclaw/src/agents/tools/sessions-access.ts:186-252`

### 19.3 Edge Cases (Thoroughly Investigated)

1. **Self-access always passes**: `requester === target → true` (line 69, `sessions-resolution.ts`)

2. **Session ID resolution bypasses spawn check**: When resolved via `sessionId` (not key), `resolvedViaSessionId: true` causes `shouldVerifyRequesterSpawnedSessionVisibility` to return `false`. BUT the gateway's `sessions.resolve` with `spawnedBy` still filters server-side. Source: `sessions-resolution.ts:172-223`

3. **Subagent sessions are NOT restricted**: `isSubagentSessionKey()` check in `sessions-access.ts:75-79` means `restrictToSpawned = false` for subagent sessions. Subagents can see sessions spawned by their parent and ancestors.

4. **`spawnedBy` is immutable**: Once set, cannot be changed or cleared. Prevents privilege escalation. Source: `openclaw/src/gateway/sessions-patch.ts:111-130`

5. **Only `subagent:*` or `acp:*` sessions support `spawnedBy`**: Regular sessions cannot have lineage tracking. Source: `sessions-patch.ts:123`

6. **Global/Unknown sessions**: Excluded from `spawnedBy` filtering entirely. Only visible with explicit `includeGlobal`/`includeUnknown` flags. Source: `openclaw/src/gateway/session-utils.ts:895-897`

7. **Cross-agent access**: Only when `visibility: "all"` AND `a2aPolicy.enabled` AND `a2aPolicy.isAllowed(requester, target)`. Pattern matching supports wildcards. Source: `sessions-access.ts:200-215`

### 19.4 Session Write Lock Details

From `openclaw/src/agents/session-write-lock.ts:444-553`:

- **Granularity**: Per session file (one `.lock` file per session store)
- **Reentrant**: Reference-counted (same process can acquire N times, must release N times)
- **Stale detection**: PID-aware — checks if lock-holding process is still alive, handles PID recycling
- **Watchdog**: Cleanup every 60 seconds (`DEFAULT_WATCHDOG_INTERVAL_MS`)
- **Max hold**: 5 minutes default (`DEFAULT_MAX_HOLD_MS`)
- **Stale timeout**: 30 minutes default (`DEFAULT_STALE_MS`)
- **Lock method**: `fs.open("wx")` (exclusive create) for atomic acquisition

---

## 20. Design Decision: Kubernetes Deployment Strategy

**Decision**: Single "swarm pod" with all services as processes (v1), evolve to K8s Operator for scale (v2). No VMs needed.

### 20.1 The Key Insight

Our swarm doesn't need separate containers per agent. All agents are **OpenCode sessions** — they run inside a single `opencode serve` process. The "swarm" is the orchestrator creating/managing sessions via the SDK. There's nothing to "spawn" at the container level.

| Component | What It Actually Is | Separate Container? |
|---|---|---|
| OpenCode server | One process serving ALL agent sessions | No |
| Orchestrator | One Node.js/Bun process | No |
| Beads | One Dolt server process | No (or external) |
| Mem0 | One Python process | External service |
| Qdrant | Vector DB for Mem0 | External StatefulSet |
| Playwright | Headless Chromium binary in container | No |
| Dashboard | SSE-powered web app | Separate Deployment |

### 20.2 Option A: Single Fat Pod (Recommended for v1)

One pod, everything as supervised processes inside a single container:

```
┌──────────────────── K8s Pod ────────────────────────┐
│  ┌────────────────────────────────────────────────┐ │
│  │              Single Container                   │ │
│  │                                                 │ │
│  │  ┌───────────┐  ┌────────────────────────────┐ │ │
│  │  │ OpenCode  │  │  Orchestrator (Node.js)    │ │ │
│  │  │ serve     │  │  - loop controller         │ │ │
│  │  │ :4096     │  │  - persona loader          │ │ │
│  │  └───────────┘  │  - review aggregator       │ │ │
│  │                  └────────────────────────────┘ │ │
│  │  ┌───────────┐  ┌────────────────────────────┐ │ │
│  │  │ Beads     │  │  Playwright (headless      │ │ │
│  │  │ daemon    │  │  Chromium, pre-installed)   │ │ │
│  │  │ :3307     │  │                            │ │ │
│  │  └───────────┘  └────────────────────────────┘ │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  Connects to external K8s Services:                  │
│  ├── mem0-api (Deployment)                           │
│  ├── qdrant (StatefulSet)                            │
│  └── dashboard (Deployment)                          │
└──────────────────────────────────────────────────────┘
```

**Dockerfile**:

```dockerfile
FROM mcr.microsoft.com/playwright:v1.50.0-noble

# System deps
RUN apt-get update && apt-get install -y supervisor curl git && rm -rf /var/lib/apt/lists/*

# Install Node.js tools
RUN npm install -g @opencode-ai/opencode @beads/bd

# Install orchestrator
COPY orchestrator/ /app/
WORKDIR /app
RUN npm ci

# Personas and OpenCode config
COPY personas/ /personas/
COPY .opencode/ /workspace/.opencode/

# Process supervisor
COPY deploy/supervisord.conf /etc/supervisord.conf

WORKDIR /workspace
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
```

**supervisord.conf**:

```ini
[supervisord]
nodaemon=true

[program:opencode]
command=opencode serve --port 4096 --hostname 127.0.0.1
directory=/workspace
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0

[program:beads]
command=bd daemon start --local
directory=/workspace
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0

[program:orchestrator]
command=node /app/orchestrator.js
directory=/workspace
autorestart=unexpected
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
```

**K8s manifest**:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: swarm-run-001
  labels:
    app: agent-swarm
    run-id: "001"
spec:
  containers:
    - name: swarm
      image: agent-swarm:latest
      resources:
        requests:
          memory: "4Gi"
          cpu: "2"
        limits:
          memory: "8Gi"
          cpu: "4"
      env:
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: llm-credentials
              key: anthropic-api-key
        - name: MEM0_API_URL
          value: "http://mem0-api:8080"
        - name: SWARM_MAX_LOOPS
          value: "3"
        - name: SWARM_INITIAL_PROMPT
          valueFrom:
            configMapKeyRef:
              name: swarm-config
              key: initial-prompt
      volumeMounts:
        - name: workspace
          mountPath: /workspace
  volumes:
    - name: workspace
      emptyDir:
        sizeLimit: 10Gi
```

### 20.3 Option B: Multi-Container Pod (Sidecar)

Better separation, same pod:

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: orchestrator
      image: swarm-orchestrator:latest
    - name: opencode
      image: opencode:latest
      command: ["opencode", "serve", "--port", "4096"]
    - name: beads
      image: beads:latest
      command: ["bd", "daemon", "start", "--local"]
  # All share localhost networking within the pod
```

### 20.4 Option C: K8s Operator (v2, Scale-Out)

For running multiple concurrent swarm instances:

```yaml
apiVersion: swarm.io/v1
kind: SwarmRun
metadata:
  name: build-dashboard
spec:
  prompt: "Build a React dashboard with auth, charts, and user management"
  maxLoops: 3
  confidenceThreshold: 0.85
  personas:
    - frontend-dev
    - backend-dev
    - security-reviewer
  model: anthropic/claude-sonnet-4-20250514
  resources:
    memory: 8Gi
    cpu: 4
```

The operator watches `SwarmRun` CRDs, creates a pod per run (Option A or B), monitors status, enforces `maxLoops`, cleans up on completion, and reports results back to the CRD status field.

### 20.5 Why NOT a VM (KubeVirt)

1. **Playwright doesn't need a VM.** Headless Chromium runs perfectly in standard containers:
   ```typescript
   import { chromium } from 'playwright'
   const browser = await chromium.launch({
     headless: true,
     args: ['--no-sandbox', '--disable-gpu']  // Required in containers
   })
   const page = await browser.newPage()
   await page.goto('http://localhost:3000')
   const screenshot = await page.screenshot({ fullPage: true })
   ```
   Screenshots, DOM inspection, visual comparison, network interception — all work headless. The Playwright Docker image (`mcr.microsoft.com/playwright`) includes pre-installed browsers.

2. **No Docker-in-Docker needed.** Agents are OpenCode sessions (in-process), not containers.

3. **VMs in K8s add massive overhead:**
   - KubeVirt requires cluster-level installation + RBAC + nested virtualization support
   - VMs take minutes to boot vs seconds for pods
   - Resource overhead: hypervisor + guest OS + your workload
   - Many cloud K8s clusters (GKE, EKS) don't support nested virtualization by default
   - Debugging: SSH into VM inside pod inside node — painful

4. **The only case for a VM**: Running Docker Compose *unchanged* inside K8s. But we're redesigning for K8s, so this doesn't apply.

### 20.6 Playwright FE Review Agent in K8s

The FE review agent works like this in a container:

```typescript
// fe-review-agent persona
async function reviewFrontend(workspace: string): Promise<ReviewResult> {
  // 1. Start dev server
  const devServer = spawn('npm', ['run', 'dev'], { cwd: workspace })
  await waitForPort(3000)

  // 2. Launch headless browser
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  })

  // 3. Take screenshots of key pages
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const screenshots: Record<string, Buffer> = {}
  for (const route of ['/login', '/dashboard', '/settings']) {
    await page.goto(`http://localhost:3000${route}`)
    await page.waitForLoadState('networkidle')
    screenshots[route] = await page.screenshot({ fullPage: true })
  }

  // 4. Run accessibility checks
  const a11y = await page.evaluate(() => {
    // Basic a11y checks: alt tags, aria labels, contrast
  })

  // 5. Check console errors
  const consoleErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await browser.close()
  devServer.kill()

  return { screenshots, a11y, consoleErrors, score: calculateScore(...) }
}
```

The screenshots can be passed to the LLM as images for visual review (OpenCode supports multimodal input).

### 20.7 Deployment Progression

| Stage | Packaging | When |
|---|---|---|
| **Local dev** | `docker compose up` (sibling containers) | Development & testing |
| **K8s production** | SwarmRun CRD + Operator + sidecar pods | See [Section 21](#21-kubernetes-operator--beads-queue) |

**Code doesn't change between stages.** The orchestrator always talks to OpenCode at `localhost:4096`, Beads at `localhost:3307`. Only the packaging differs.

### 20.8 Shared External Services

These run as separate K8s Deployments/StatefulSets, shared across all swarm runs:

```yaml
# Qdrant for Mem0 vector storage
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: qdrant
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: qdrant
          image: qdrant/qdrant:latest
          ports: [{containerPort: 6333}]
          volumeMounts:
            - name: storage
              mountPath: /qdrant/storage
  volumeClaimTemplates:
    - metadata:
        name: storage
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 20Gi
---
# Mem0 API server
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mem0-api
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: mem0
          image: mem0-api:latest
          env:
            - name: QDRANT_URL
              value: "http://qdrant:6333"
          ports: [{containerPort: 8080}]
---
# Dashboard
apiVersion: apps/v1
kind: Deployment
metadata:
  name: swarm-dashboard
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: dashboard
          image: swarm-dashboard:latest
          ports: [{containerPort: 3000}]
```

---

## 21. Kubernetes Operator & Beads Queue

**POC environment**: kind (K8s-in-Docker) — `brew install kind && kind create cluster --name swarm-poc`

### 21.1 SwarmRun CRD

Users submit tasks by creating a `SwarmRun` custom resource:

```yaml
apiVersion: swarm.agentswarm.io/v1alpha1
kind: SwarmRun
metadata:
  name: build-dashboard
spec:
  prompt: "Build a React dashboard with auth, charts, and user management"
  maxLoops: 3
  confidenceThreshold: 0.85
  personas: [frontend-dev, backend-dev, security-reviewer]
  model: anthropic/claude-sonnet-4-20250514
  resources:
    opencode: { memory: "4Gi", cpu: "2" }
    orchestrator: { memory: "2Gi", cpu: "1" }
    beads: { memory: "1Gi", cpu: "0.5" }
    playwright: { memory: "2Gi", cpu: "1" }
  timeout: "2h"
  priority: 1
```

**Status fields**: phase, beadsIssueId, podName, currentLoop, confidence, startTime, completionTime, message, conditions, results.

### 21.2 Sidecar Pod Pattern (Chosen)

Each SwarmRun creates a multi-container pod with 4 containers sharing `localhost` + emptyDir `/workspace`:

```
┌────────────────────── K8s Pod ──────────────────────┐
│  ┌───────────┐  ┌────────────────────────────────┐  │
│  │ opencode  │  │ orchestrator (main)            │  │
│  │ :4096     │  │ :3000                          │  │
│  │ 4Gi/2cpu  │  │ 2Gi/1cpu                       │  │
│  └───────────┘  └────────────────────────────────┘  │
│  ┌───────────┐  ┌────────────────────────────────┐  │
│  │ beads     │  │ playwright                     │  │
│  │ :3307     │  │ (sleep infinity, on-demand)    │  │
│  │ 1Gi/0.5  │  │ 2Gi/1cpu                       │  │
│  └───────────┘  └────────────────────────────────┘  │
│  Shared: emptyDir /workspace, localhost networking   │
└──────────────────────────────────────────────────────┘
```

**Startup ordering**: Orchestrator's `entrypoint.sh` polls `localhost:4096` (OpenCode) and `localhost:3307` (Beads) before starting:
```bash
#!/bin/bash
until curl -sf http://localhost:4096/health > /dev/null 2>&1; do sleep 1; done
until curl -sf http://localhost:3307/ > /dev/null 2>&1; do sleep 1; done
exec node /app/orchestrator.js
```

**Completion detection**: The pod never reaches `Succeeded` on its own (opencode/beads/playwright run forever). The operator watches the orchestrator container's termination status specifically, reads the result, then deletes the pod.

### 21.3 Two-Level Termination Signals

**Level 1 — Subagent → Orchestrator** (inside pod, per-task):
- OpenCode session completes → SDK returns result to orchestrator
- Subagent closes its Beads task: `bd close <task-id>`
- No file markers needed — SDK + Beads-level signaling

**Level 2 — Orchestrator → K8s Operator** (pod to cluster, per-run):
- Orchestrator writes to BOTH:
  - `/dev/termination-log`: `SWARM_RUN_COMPLETE:{json}` (K8s-native, 4KB limit)
  - `/workspace/.swarm/result.json`: full result (archival, debugging)
- Exit codes: `0` = success, `1` = failure, `2` = max loops reached
- Operator reads from `pod.status.containerStatuses["orchestrator"].state.terminated.message`

**Result JSON**:
```json
{
  "marker": "SWARM_RUN_COMPLETE",
  "status": "success",
  "confidence": 0.87,
  "loopsExecuted": 2,
  "maxLoops": 3,
  "totalTasks": 8,
  "completedTasks": 7,
  "followUpTasks": 1,
  "deferredTaskIds": ["ksw-a1b2"],
  "tokenUsage": { "total": 150000, "perAgent": { "frontend-dev": 45000 } },
  "duration": { "totalMs": 360000, "perLoop": [180000, 180000] },
  "errors": []
}
```

### 21.4 Concurrency: Max 5 Runs + Beads Queue

**Strict enforcement** via dual check:
1. Count active K8s pods with label `app=agent-swarm` (not in terminal state)
2. Count Beads issues with status `in_progress` and label `swarm-run`
3. Use the higher count (conservative). If ≥5, no new pods.

**Queue lifecycle**:

| Event | Beads Action | Status |
|---|---|---|
| SwarmRun CRD created | `bd create "<prompt>" -t task -p <priority>` | `open` (queued) |
| Slot available | `bd update <id> --claim` (atomic) | `in_progress` |
| Run completed | `bd close <id>` | `closed` |
| CRD deleted while queued | `bd close <id>` | `closed` |

**Queue ordering**: `bd ready --json` returns priority-sorted unblocked tasks. Highest priority (lowest number) Queued SwarmRun gets the next slot. Equal priority = FIFO by creation time.

### 21.5 Operator Architecture

**Reconcile state machine**:
```
SwarmRun created → bd create → phase=Queued
  → slot available? → bd update --claim → create sidecar pod → phase=Running
    → orchestrator container exits 0 → read result → bd close → phase=Completed → drain queue
    → orchestrator container exits non-zero → bd close → phase=Failed → drain queue
    → timeout exceeded → kill pod → bd close → phase=TimedOut → drain queue
    → pod disappears → bd close → phase=Failed → drain queue
```

**Recovery on operator restart**: The same reconcile loop handles both steady-state and recovery. On startup, it re-reads all SwarmRun CRDs, all managed pods, and Beads state, cross-references them, and resolves any inconsistencies.

### 21.6 RBAC

**Operator** (ClusterRole `swarmrun-operator`):
- `swarm.agentswarm.io`: swarmruns, swarmruns/status — all verbs
- `core`: pods, pods/log, pods/status — get, list, watch, create, delete
- `core`: events — create, patch
- `apiextensions.k8s.io`: CRDs — get, create, update

**Swarm runner pods** (ClusterRole `swarm-runner`):
- `core`: pods — get, patch (own annotations only, for reporting internal phase)

### 21.7 Operator Package

```
operator/
├── manifests/           # K8s YAML (CRD, RBAC, Deployment, ConfigMap)
├── images/              # Dockerfiles for sidecar containers
│   ├── orchestrator/    # Node.js + Playwright + orchestrator + entrypoint.sh
│   ├── opencode/        # OpenCode + agents + custom tools + plugins
│   └── beads/           # Beads + bd init config
├── src/
│   ├── index.ts         # Entry: init K8s clients, start watchers, reconcile loop
│   ├── types.ts         # SwarmRun CRD interfaces + Zod schemas
│   ├── config.ts        # Env-based config with defaults
│   ├── logger.ts        # Structured JSON logging
│   ├── watcher.ts       # K8s Informer for SwarmRun CRDs + Pods
│   ├── reconciler.ts    # Core state machine
│   ├── concurrency.ts   # Dual check (pods + Beads), strict max 5
│   ├── beads-queue.ts   # bd CLI wrapper (create, claim, close, ready)
│   ├── pod-template.ts  # Sidecar pod spec generator (4 containers)
│   ├── status.ts        # CRD status updater
│   ├── cleanup.ts       # Pod retention, stale detection, orphans
│   └── errors.ts        # Error classification, exponential backoff
├── Dockerfile           # Operator image
├── package.json         # @kubernetes/client-node, zod
└── tsconfig.json
```
