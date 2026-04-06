import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as path from "path"

const LOCK_DIR = "/workspace/.swarm/locks"
const WRITE_TOOLS = ["write", "edit"]
const CLAUDE_PATTERN = /(?:^|\/|\\)\.claude(?:\/|\\|$)/

function encodePath(filePath: string): string {
  return filePath.replace(/\//g, "__")
}

function isClaudeTarget(filePath: string | undefined): boolean {
  if (!filePath) return false
  return CLAUDE_PATTERN.test(filePath)
}

function bashTargetsClaude(command: string | undefined): boolean {
  if (!command) return false
  return CLAUDE_PATTERN.test(command)
}

function isWriteOrEditTool(toolName: string): boolean {
  return WRITE_TOOLS.some((t) => toolName.toLowerCase().includes(t))
}

function isBashTool(toolName: string): boolean {
  return toolName.toLowerCase().includes("bash")
}

function acquireLock(
  filePath: string,
  agentId: string,
): { acquired: boolean; owner?: string } {
  const lockFile = path.join(LOCK_DIR, `${encodePath(filePath)}.lock`)
  const content = `${agentId}\n${Date.now()}`
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true })

    // Atomic create — O_CREAT | O_EXCL, fails with EEXIST if file exists
    fs.writeFileSync(lockFile, content, { flag: "wx" })
    return { acquired: true }
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      // Lock file already exists — check owner
      try {
        const existing = fs.readFileSync(lockFile, "utf-8")
        const owner = existing.split("\n")[0]
        if (owner === agentId) {
          // Reentrant — same agent, just update the timestamp
          fs.writeFileSync(lockFile, content)
          return { acquired: true }
        }
        return { acquired: false, owner }
      } catch (readErr) {
        console.warn(`[swarm-guard] Failed to read lock for ${filePath}:`, readErr)
        return { acquired: true }
      }
    }
    console.warn(`[swarm-guard] Failed to acquire lock for ${filePath}:`, err)
    // Fail open — don't crash, allow the operation
    return { acquired: true }
  }
}

function releaseLock(filePath: string, agentId: string): void {
  const lockFile = path.join(LOCK_DIR, `${encodePath(filePath)}.lock`)
  try {
    if (!fs.existsSync(lockFile)) return
    const content = fs.readFileSync(lockFile, "utf-8")
    const owner = content.split("\n")[0]
    if (owner === agentId) {
      fs.unlinkSync(lockFile)
    }
  } catch (err) {
    console.warn(`[swarm-guard] Failed to release lock for ${filePath}:`, err)
  }
}

export const SwarmGuard: Plugin = async ({ project, client, $, directory }) => {
  const agentId = process.env.SWARM_AGENT_ID || "unknown"
  const agentRole = process.env.SWARM_AGENT_ROLE || ""

  return {
    "tool.execute.before": async (input, output) => {
      const toolName = input.tool || ""
      const args = input.args || {}

      // Rule 3: Read-only enforcement for reviewer agents
      if (agentRole === "reviewer") {
        if (isWriteOrEditTool(toolName) || isBashTool(toolName)) {
          return output.deny(
            "Reviewer agents are read-only — write/edit/bash operations are blocked",
          )
        }
      }

      // Rule 1: .claude protection
      if (isWriteOrEditTool(toolName) && isClaudeTarget(args.file_path)) {
        return output.deny("Cannot modify .claude files/directories")
      }
      if (isBashTool(toolName) && bashTargetsClaude(args.command)) {
        return output.deny("Cannot modify .claude files/directories")
      }

      // Rule 2: File locking for write/edit tools
      if (isWriteOrEditTool(toolName) && args.file_path) {
        const result = acquireLock(args.file_path, agentId)
        if (!result.acquired) {
          return output.deny(`File locked by ${result.owner}`)
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      const toolName = input.tool || ""
      const args = input.args || {}

      // Rule 2: Release lock after write/edit completes
      if (isWriteOrEditTool(toolName) && args.file_path) {
        releaseLock(args.file_path, agentId)
      }
    },
  }
}

export default SwarmGuard
