// ---------------------------------------------------------------------------
// llm-wait — wait for OpenCode async LLM responses via SSE event stream
// ---------------------------------------------------------------------------
//
// OpenCode v1.x's session.prompt() is fire-and-forget: it POSTs the prompt to
// /session/{id}/message and returns 200 OK with empty body. The actual LLM
// response comes via SSE events on /event with type "message.updated".
//
// This module exposes:
//   - openCompletionWaiter() — opens an SSE stream and returns a promise that
//     resolves when an assistant message in the given session reaches
//     time.completed. Call BEFORE sending the prompt to avoid race conditions.
//   - extractTextFromParts() — concatenates text from a message's parts array.
//
// ---------------------------------------------------------------------------

import { logger } from "./logger.js";

export interface MessagePart {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface CompletedMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  parts: MessagePart[];
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  cost: number;
  finish?: string;
}

/**
 * Minimal interface for the OpenCode SDK client used by this module.
 * Defined here so the module can be tested with a mock.
 */
export interface OpenCodeClientLike {
  session: {
    messages: (opts: { path: { id: string } }) => Promise<unknown>;
  };
  event: {
    subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
  };
}

/**
 * Open an SSE event stream and return a Promise that resolves when the
 * given session emits `session.idle` (the agent has finished all its work).
 *
 * Why session.idle instead of message.updated:
 * The agent may emit several intermediate `message.updated` events with
 * `time.completed` set (e.g., a brief "I'll explore..." then tool calls
 * then more text). We need the FINAL state, which is signaled by
 * `session.idle` — no more pending work.
 *
 * IMPORTANT: Call this BEFORE sending the prompt, then send the prompt,
 * then await the returned promise. Otherwise the idle event may be missed.
 *
 * Usage:
 *   const { wait } = await openCompletionWaiter(client, sessionId, 600_000);
 *   await client.session.prompt({ ... });   // fire-and-forget
 *   const completed = await wait;            // resolves with last assistant message
 */
export async function openCompletionWaiter(
  client: OpenCodeClientLike,
  sessionId: string,
  timeoutMs: number = 600_000,
): Promise<{ wait: Promise<CompletedMessage> }> {
  const eventResult = await client.event.subscribe();

  const wait = new Promise<CompletedMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`LLM prompt timeout after ${timeoutMs}ms (session ${sessionId})`));
    }, timeoutMs);

    (async () => {
      try {
        for await (const raw of eventResult.stream) {
          const event = raw as {
            type?: string;
            properties?: { info?: any; sessionID?: string };
          };

          // Wait for session to go idle (all work done)
          if (
            event.type === "session.idle" &&
            event.properties?.sessionID === sessionId
          ) {
            // Fetch all messages and find the last assistant message
            try {
              const messagesResp = await client.session.messages({ path: { id: sessionId } });
              const messagesData = unwrapSDKResponse(messagesResp) as Array<{ info?: any; parts?: MessagePart[] }> | undefined;

              if (!Array.isArray(messagesData) || messagesData.length === 0) {
                clearTimeout(timer);
                reject(new Error(`Session ${sessionId} idle but no messages found`));
                return;
              }

              // Find the last assistant message
              let lastAssistant: { info?: any; parts?: MessagePart[] } | undefined;
              for (let i = messagesData.length - 1; i >= 0; i--) {
                if (messagesData[i]?.info?.role === "assistant") {
                  lastAssistant = messagesData[i];
                  break;
                }
              }

              if (!lastAssistant?.info) {
                clearTimeout(timer);
                reject(new Error(`Session ${sessionId} idle but no assistant message found`));
                return;
              }

              const info = lastAssistant.info;

              // Check for LLM-level errors
              if (info.error) {
                clearTimeout(timer);
                reject(new Error(`LLM error in session ${sessionId}: ${JSON.stringify(info.error).slice(0, 300)}`));
                return;
              }

              clearTimeout(timer);
              resolve({
                id: info.id,
                sessionID: sessionId,
                role: "assistant",
                parts: lastAssistant.parts ?? [],
                tokens: info.tokens ?? {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                cost: info.cost ?? 0,
                finish: info.finish,
              });
              return;
            } catch (err) {
              clearTimeout(timer);
              reject(err instanceof Error ? err : new Error(String(err)));
              return;
            }
          }

          // Session-level errors (separate from idle)
          if (
            event.type === "session.error" &&
            event.properties?.sessionID === sessionId
          ) {
            clearTimeout(timer);
            reject(new Error(`Session error in ${sessionId}: ${JSON.stringify(event.properties).slice(0, 300)}`));
            return;
          }
        }

        // Stream ended without seeing idle
        clearTimeout(timer);
        reject(new Error(`Event stream ended without session idle (session ${sessionId})`));
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });

  return { wait };
}

/** Unwrap hey-api SDK response: { data, error, request, response } → data */
function unwrapSDKResponse(resp: unknown): unknown {
  if (resp && typeof resp === "object" && "data" in resp) {
    return (resp as { data: unknown }).data;
  }
  return resp;
}

/**
 * Extract the concatenated text from an assistant message's parts.
 * Used by structured output parsers (planner, reviewer).
 *
 * Filters to only TextPart entries (type === "text"), ignoring tool calls,
 * file edits, snapshots, etc. Concatenates with newlines.
 */
export function extractTextFromParts(parts: MessagePart[]): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("\n");
}

/**
 * Try to parse a JSON object from a text string. Falls back to extracting
 * a JSON code block (```json ... ``` or ``` ... ```) if direct parse fails.
 * Returns null if no valid JSON can be extracted.
 */
export function parseJsonFromText<T = unknown>(text: string): T | null {
  if (!text) return null;
  // Try direct parse first
  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall through to code block extraction
  }
  // Try fenced code block: ```json\n...\n``` or ```\n...\n```
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1]) as T;
    } catch {
      // Fall through
    }
  }
  // Try first {...} block in the text
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]) as T;
    } catch {
      // Fall through
    }
  }
  return null;
}
