// ---------------------------------------------------------------------------
// Telegram Bot — prompt submission, status queries, and push notifications
// ---------------------------------------------------------------------------

import { Bot } from "grammy";
import { K8sClient, type SwarmRunSummary } from "./k8s.js";
import { StuckDetector } from "./stuck-detector.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const NAMESPACE = process.env.NAMESPACE ?? "default";
const STUCK_MINUTES = parseInt(process.env.STUCK_THRESHOLD_MINUTES ?? "10", 10);
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:3000";

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const bot = new Bot(BOT_TOKEN);
const k8s = new K8sClient(NAMESPACE);
const stuckDetector = new StuckDetector(STUCK_MINUTES);

// Track previous phases for transition detection
const previousPhases = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helper: generate K8s-safe name from prompt
// ---------------------------------------------------------------------------

function promptToName(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const hash = Math.random().toString(36).slice(2, 6);
  return `${slug}-${hash}`;
}

// ---------------------------------------------------------------------------
// Helper: format run as text
// ---------------------------------------------------------------------------

function formatRun(run: SwarmRunSummary, detailed = false): string {
  const phase = phaseEmoji(run.phase);
  const loop = run.currentLoop !== undefined ? `${run.currentLoop}/${run.maxLoops ?? "?"}` : "-";
  const conf = run.confidence !== undefined ? `${(run.confidence * 100).toFixed(0)}%` : "-";
  const line = `${phase} *${run.name}* | Loop: ${loop} | Confidence: ${conf}`;

  if (!detailed) return line;

  const parts = [line];
  if (run.startTime) {
    const elapsed = Date.now() - new Date(run.startTime).getTime();
    parts.push(`Duration: ${Math.floor(elapsed / 60000)}m`);
  }
  if (run.podName) parts.push(`Pod: \`${run.podName}\``);
  if (run.message) parts.push(`Message: ${run.message}`);
  parts.push(`Dashboard: ${DASHBOARD_URL}`);
  return parts.join("\n");
}

function phaseEmoji(phase: string): string {
  switch (phase) {
    case "Queued": return "⏳";
    case "Running": return "🔄";
    case "Reviewing": return "🔍";
    case "Completed": return "✅";
    case "Failed": return "❌";
    case "TimedOut": return "⏰";
    default: return "❓";
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

bot.command("start", (ctx) => {
  ctx.reply(
    "Swarm Agent Bot\n\n" +
    "/run <prompt> — start a new swarm run\n" +
    "/status — list all runs\n" +
    "/status <name> — detailed run info\n" +
    "/cancel <name> — cancel a run\n" +
    "/link — dashboard URL",
  );
});

bot.command("run", async (ctx) => {
  const text = ctx.match?.trim();
  if (!text) {
    await ctx.reply("Usage: /run <prompt>\nExample: /run Add JWT authentication with refresh tokens");
    return;
  }

  // Parse optional flags
  let prompt = text;
  let maxLoops = 3;
  let priority = 2;

  const loopsMatch = text.match(/--loops\s+(\d+)/);
  if (loopsMatch) {
    maxLoops = parseInt(loopsMatch[1], 10);
    prompt = prompt.replace(loopsMatch[0], "").trim();
  }

  const priorityMatch = text.match(/--priority\s+(\d+)/);
  if (priorityMatch) {
    priority = parseInt(priorityMatch[1], 10);
    prompt = prompt.replace(priorityMatch[0], "").trim();
  }

  const name = promptToName(prompt);

  try {
    await k8s.createSwarmRun({ name, prompt, maxLoops, priority });
    await ctx.reply(`🚀 SwarmRun created: \`${name}\`\nPrompt: ${prompt}\nLoops: ${maxLoops} | Priority: P${priority}`, { parse_mode: "Markdown" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ Failed to create run: ${msg}`);
  }
});

bot.command("status", async (ctx) => {
  const name = ctx.match?.trim();

  if (name) {
    // Detailed single run
    const run = await k8s.getSwarmRun(name);
    if (!run) {
      await ctx.reply(`Run \`${name}\` not found.`, { parse_mode: "Markdown" });
      return;
    }
    await ctx.reply(formatRun(run, true), { parse_mode: "Markdown" });
  } else {
    // All runs
    const runs = await k8s.listSwarmRuns();
    if (runs.length === 0) {
      await ctx.reply("No swarm runs found.");
      return;
    }
    const lines = runs.map((r) => formatRun(r));
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  }
});

bot.command("cancel", async (ctx) => {
  const name = ctx.match?.trim();
  if (!name) {
    await ctx.reply("Usage: /cancel <run-name>");
    return;
  }

  try {
    await k8s.deleteSwarmRun(name);
    await ctx.reply(`🗑️ Cancelled: \`${name}\``, { parse_mode: "Markdown" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ Failed to cancel: ${msg}`);
  }
});

bot.command("link", (ctx) => {
  ctx.reply(`Dashboard: ${DASHBOARD_URL}`);
});

// ---------------------------------------------------------------------------
// Push notifications via K8s informer
// ---------------------------------------------------------------------------

function sendNotification(text: string): void {
  if (!CHAT_ID) return;
  bot.api.sendMessage(CHAT_ID, text, { parse_mode: "Markdown" }).catch((err) => {
    console.error("Failed to send notification:", err);
  });
}

function handleRunUpdate(run: SwarmRunSummary): void {
  const prevPhase = previousPhases.get(run.name);
  previousPhases.set(run.name, run.phase);

  // Phase transition notifications
  if (prevPhase !== run.phase) {
    switch (run.phase) {
      case "Running":
        if (prevPhase === "Queued") {
          sendNotification(`🔄 *${run.name}* started running`);
        }
        break;
      case "Completed":
        sendNotification(
          `✅ *${run.name}* completed\n` +
          `Confidence: ${run.confidence !== undefined ? `${(run.confidence * 100).toFixed(0)}%` : "?"}\n` +
          `Loops: ${run.currentLoop ?? "?"}`,
        );
        break;
      case "Failed":
        sendNotification(`❌ *${run.name}* failed\n${run.message ?? ""}`);
        break;
      case "TimedOut":
        sendNotification(`⏰ *${run.name}* timed out`);
        break;
    }
  }

  // Loop progress (only if confidence changed and still running)
  if (
    run.phase === "Running" &&
    prevPhase === "Running" &&
    run.confidence !== undefined
  ) {
    // Check stuck detector
    const isStuck = stuckDetector.update(run);
    if (isStuck) {
      sendNotification(
        `⚠️ *${run.name}* appears stuck!\n` +
        `No progress for ${STUCK_MINUTES} minutes.\n` +
        `Loop: ${run.currentLoop ?? "?"} | Confidence: ${(run.confidence * 100).toFixed(0)}%\n` +
        `Check: ${DASHBOARD_URL}`,
      );
    }
  }
}

function handleRunDelete(name: string): void {
  previousPhases.delete(name);
  stuckDetector.remove(name);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Starting Swarm Telegram Bot...");

  // Start K8s informer for push notifications
  if (CHAT_ID) {
    const informer = k8s.createInformer(handleRunUpdate, handleRunDelete);
    await informer.start();
    console.log(`Push notifications enabled for chat ${CHAT_ID}`);
  } else {
    console.log("TELEGRAM_CHAT_ID not set — push notifications disabled");
  }

  // Start bot polling
  await bot.start({
    onStart: () => console.log("Telegram bot is running"),
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
