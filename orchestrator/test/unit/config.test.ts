import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Minimum required env
    process.env.SWARM_INITIAL_PROMPT = "test";
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("returns default values when only SWARM_INITIAL_PROMPT is set", () => {
    const cfg = loadConfig();

    expect(cfg.opencodeHost).toBe("127.0.0.1");
    expect(cfg.opencodePort).toBe(4096);
    expect(cfg.runName).toBe("local-run");
    expect(cfg.maxLoops).toBe(3);
    expect(cfg.confidenceThreshold).toBe(0.85);
    expect(cfg.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(cfg.maxPlanLoops).toBe(3);
    expect(cfg.planApprovalThreshold).toBe(0.8);
    expect(cfg.mem0ApiUrl).toBe("http://localhost:8080");
  });

  it("throws when SWARM_INITIAL_PROMPT is missing", () => {
    delete process.env.SWARM_INITIAL_PROMPT;
    expect(() => loadConfig()).toThrow("SWARM_INITIAL_PROMPT is required");
  });

  it("throws when SWARM_INITIAL_PROMPT is empty string", () => {
    process.env.SWARM_INITIAL_PROMPT = "";
    expect(() => loadConfig()).toThrow("SWARM_INITIAL_PROMPT is required");
  });

  it("parses personas from comma-separated string", () => {
    process.env.SWARM_PERSONAS = "a, b, c";
    const cfg = loadConfig();
    expect(cfg.personas).toEqual(["a", "b", "c"]);
  });

  it("returns empty array when personas is empty string", () => {
    process.env.SWARM_PERSONAS = "";
    const cfg = loadConfig();
    expect(cfg.personas).toEqual([]);
  });

  it("hard-caps maxPlanLoops at 10", () => {
    process.env.SWARM_MAX_PLAN_LOOPS = "50";
    const cfg = loadConfig();
    expect(cfg.maxPlanLoops).toBe(10);
  });

  it("allows maxPlanLoops below 10", () => {
    process.env.SWARM_MAX_PLAN_LOOPS = "7";
    const cfg = loadConfig();
    expect(cfg.maxPlanLoops).toBe(7);
  });

  it("parses numeric confidence threshold from env", () => {
    process.env.SWARM_CONFIDENCE_THRESHOLD = "0.95";
    const cfg = loadConfig();
    expect(cfg.confidenceThreshold).toBe(0.95);
  });

  it("reads initialPrompt from env", () => {
    process.env.SWARM_INITIAL_PROMPT = "build me a website";
    const cfg = loadConfig();
    expect(cfg.initialPrompt).toBe("build me a website");
  });
});
