// ---------------------------------------------------------------------------
// Orchestrator configuration — reads from environment variables
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  // OpenCode connection
  opencodeHost: string;
  opencodePort: number;

  // Swarm run parameters (injected by K8s operator via env)
  runName: string;
  initialPrompt: string;
  maxLoops: number;
  confidenceThreshold: number;
  model: string;
  personas: string[]; // Comma-separated in env, parsed to array

  // Plan review loop
  maxPlanLoops: number; // How many plan↔review iterations before accepting (hard cap: 10)
  planApprovalThreshold: number; // Score (0-1) at which the plan is auto-approved

  // Mem0
  mem0ApiUrl: string;

  // Paths
  workspacePath: string;
  personasPath: string;
  swarmStatePath: string;
}

export function loadConfig(): OrchestratorConfig {
  const raw = {
    opencodeHost: process.env.OPENCODE_HOST ?? "127.0.0.1",
    opencodePort: parseInt(process.env.OPENCODE_PORT ?? "4096", 10),
    runName: process.env.SWARM_RUN_NAME ?? "local-run",
    initialPrompt: process.env.SWARM_INITIAL_PROMPT ?? "",
    maxLoops: parseInt(process.env.SWARM_MAX_LOOPS ?? "3", 10),
    confidenceThreshold: parseFloat(process.env.SWARM_CONFIDENCE_THRESHOLD ?? "0.85"),
    model: process.env.SWARM_MODEL ?? "anthropic/claude-sonnet-4-20250514",
    personas: (process.env.SWARM_PERSONAS ?? "").split(",").map(s => s.trim()).filter(Boolean),
    maxPlanLoops: Math.min(parseInt(process.env.SWARM_MAX_PLAN_LOOPS ?? "3", 10), 10), // Hard cap at 10
    planApprovalThreshold: parseFloat(process.env.SWARM_PLAN_APPROVAL_THRESHOLD ?? "0.8"),
    mem0ApiUrl: process.env.MEM0_API_URL ?? "http://localhost:8080",
    workspacePath: process.env.WORKSPACE_PATH ?? "/workspace",
    personasPath: process.env.PERSONAS_PATH ?? "/workspace/.opencode/agents",
    swarmStatePath: process.env.SWARM_STATE_PATH ?? "/workspace/.swarm",
  };

  if (!raw.initialPrompt) {
    throw new Error("SWARM_INITIAL_PROMPT is required");
  }

  return raw;
}
