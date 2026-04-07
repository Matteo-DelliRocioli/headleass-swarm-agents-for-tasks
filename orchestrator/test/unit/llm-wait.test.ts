import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  openCompletionWaiter,
  extractTextFromParts,
  parseJsonFromText,
  type OpenCodeClientLike,
} from "../../src/llm-wait.js";

// ---------------------------------------------------------------------------
// Helper: build a mock OpenCode client with a controllable event stream
// ---------------------------------------------------------------------------

function makeMockClient(opts: {
  events: Array<unknown>;
  messagesResp?: unknown;
}): OpenCodeClientLike {
  return {
    session: {
      messages: vi.fn().mockResolvedValue(opts.messagesResp ?? { data: [] }),
    },
    event: {
      subscribe: vi.fn().mockResolvedValue({
        stream: (async function* () {
          for (const e of opts.events) {
            yield e;
          }
        })(),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// extractTextFromParts
// ---------------------------------------------------------------------------

describe("extractTextFromParts", () => {
  it("extracts text from a single TextPart", () => {
    expect(extractTextFromParts([{ type: "text", text: "hello" }])).toBe("hello");
  });

  it("concatenates multiple TextParts with newlines", () => {
    expect(extractTextFromParts([
      { type: "text", text: "line 1" },
      { type: "text", text: "line 2" },
    ])).toBe("line 1\nline 2");
  });

  it("ignores non-text parts", () => {
    expect(extractTextFromParts([
      { type: "tool", name: "read" },
      { type: "text", text: "hello" },
      { type: "file", path: "/x" },
    ])).toBe("hello");
  });

  it("returns empty string for empty array", () => {
    expect(extractTextFromParts([])).toBe("");
  });

  it("returns empty string when no text parts present", () => {
    expect(extractTextFromParts([{ type: "tool", name: "read" }])).toBe("");
  });

  it("returns empty string for non-array input", () => {
    expect(extractTextFromParts(undefined as any)).toBe("");
    expect(extractTextFromParts(null as any)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseJsonFromText
// ---------------------------------------------------------------------------

describe("parseJsonFromText", () => {
  it("parses direct JSON", () => {
    expect(parseJsonFromText('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON inside a json-fenced code block", () => {
    const text = "Here is the plan:\n\n```json\n{\"a\":1}\n```\n\nDone.";
    expect(parseJsonFromText(text)).toEqual({ a: 1 });
  });

  it("parses JSON inside a generic fenced code block", () => {
    const text = "```\n{\"a\":1}\n```";
    expect(parseJsonFromText(text)).toEqual({ a: 1 });
  });

  it("falls back to first {...} block", () => {
    const text = "Some preamble {\"a\":1} trailing text";
    expect(parseJsonFromText(text)).toEqual({ a: 1 });
  });

  it("returns null for unparseable text", () => {
    expect(parseJsonFromText("just plain text")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseJsonFromText("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// openCompletionWaiter
// ---------------------------------------------------------------------------

describe("openCompletionWaiter", () => {
  const sessionId = "ses_test123";

  it("resolves when a matching completed assistant message arrives", async () => {
    const client = makeMockClient({
      events: [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_1",
              sessionID: sessionId,
              role: "assistant",
              time: { created: 1, completed: 2 },
              tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0.001,
            },
          },
        },
      ],
      messagesResp: {
        data: [
          {
            info: { id: "msg_1", sessionID: sessionId },
            parts: [{ type: "text", text: "hello world" }],
          },
        ],
      },
    });

    const { wait } = await openCompletionWaiter(client, sessionId, 5000);
    const completed = await wait;

    expect(completed.id).toBe("msg_1");
    expect(completed.sessionID).toBe(sessionId);
    expect(completed.parts).toEqual([{ type: "text", text: "hello world" }]);
    expect(completed.tokens.input).toBe(100);
    expect(completed.tokens.output).toBe(50);
    expect(completed.cost).toBe(0.001);
  });

  it("ignores events from other sessions", async () => {
    const client = makeMockClient({
      events: [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_other",
              sessionID: "ses_OTHER",
              role: "assistant",
              time: { created: 1, completed: 2 },
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_1",
              sessionID: sessionId,
              role: "assistant",
              time: { created: 1, completed: 2 },
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
            },
          },
        },
      ],
      messagesResp: { data: [{ info: { id: "msg_1" }, parts: [] }] },
    });

    const { wait } = await openCompletionWaiter(client, sessionId, 5000);
    const completed = await wait;
    expect(completed.id).toBe("msg_1");
  });

  it("ignores user messages (only waits for assistant)", async () => {
    const client = makeMockClient({
      events: [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_user",
              sessionID: sessionId,
              role: "user",
              time: { created: 1, completed: 2 },
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_assistant",
              sessionID: sessionId,
              role: "assistant",
              time: { created: 1, completed: 2 },
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
            },
          },
        },
      ],
      messagesResp: { data: [{ info: { id: "msg_assistant" }, parts: [] }] },
    });

    const { wait } = await openCompletionWaiter(client, sessionId, 5000);
    const completed = await wait;
    expect(completed.id).toBe("msg_assistant");
  });

  it("ignores in-progress messages (no time.completed)", async () => {
    const client = makeMockClient({
      events: [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_progress",
              sessionID: sessionId,
              role: "assistant",
              time: { created: 1 }, // no completed
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_done",
              sessionID: sessionId,
              role: "assistant",
              time: { created: 1, completed: 2 },
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
            },
          },
        },
      ],
      messagesResp: { data: [{ info: { id: "msg_done" }, parts: [] }] },
    });

    const { wait } = await openCompletionWaiter(client, sessionId, 5000);
    const completed = await wait;
    expect(completed.id).toBe("msg_done");
  });

  it("rejects when assistant message has an error field", async () => {
    const client = makeMockClient({
      events: [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_err",
              sessionID: sessionId,
              role: "assistant",
              time: { created: 1, completed: 2 },
              error: { name: "ProviderAuthError", data: { message: "Invalid API key" } },
            },
          },
        },
      ],
    });

    const { wait } = await openCompletionWaiter(client, sessionId, 5000);
    await expect(wait).rejects.toThrow(/LLM error/i);
  });

  it("rejects on session.error event", async () => {
    const client = makeMockClient({
      events: [
        {
          type: "session.error",
          properties: { sessionID: sessionId, error: "boom" },
        },
      ],
    });

    const { wait } = await openCompletionWaiter(client, sessionId, 5000);
    await expect(wait).rejects.toThrow(/Session error/i);
  });

  it("rejects on timeout when no events arrive", async () => {
    // Stream that yields nothing then ends — wait should hit timeout first
    const client: OpenCodeClientLike = {
      session: { messages: vi.fn().mockResolvedValue({ data: [] }) },
      event: {
        subscribe: vi.fn().mockResolvedValue({
          stream: (async function* () {
            // Never yields
            await new Promise(() => {});
          })(),
        }),
      },
    };

    const { wait } = await openCompletionWaiter(client, sessionId, 50);
    await expect(wait).rejects.toThrow(/timeout/i);
  });

  it("rejects when stream ends without completion", async () => {
    const client = makeMockClient({
      events: [
        // Some unrelated events
        { type: "session.idle", properties: { sessionID: "ses_OTHER" } },
      ],
    });

    const { wait } = await openCompletionWaiter(client, sessionId, 5000);
    await expect(wait).rejects.toThrow(/ended without completion/i);
  });

  it("calls session.messages() with correct path after seeing completion", async () => {
    const messagesMock = vi.fn().mockResolvedValue({ data: [] });
    const client: OpenCodeClientLike = {
      session: { messages: messagesMock },
      event: {
        subscribe: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield {
              type: "message.updated",
              properties: {
                info: {
                  id: "msg_1",
                  sessionID: sessionId,
                  role: "assistant",
                  time: { created: 1, completed: 2 },
                  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                  cost: 0,
                },
              },
            };
          })(),
        }),
      },
    };

    const { wait } = await openCompletionWaiter(client, sessionId, 5000);
    await wait;

    expect(messagesMock).toHaveBeenCalledWith({ path: { id: sessionId } });
  });

  it("unwraps SDK response wrapper when fetching messages", async () => {
    // messagesResp wrapped in { data: [...] }
    const client = makeMockClient({
      events: [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_w",
              sessionID: sessionId,
              role: "assistant",
              time: { created: 1, completed: 2 },
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
            },
          },
        },
      ],
      messagesResp: {
        data: [{ info: { id: "msg_w" }, parts: [{ type: "text", text: "wrapped" }] }],
      },
    });

    const { wait } = await openCompletionWaiter(client, sessionId, 5000);
    const completed = await wait;
    expect(completed.parts).toEqual([{ type: "text", text: "wrapped" }]);
  });

  it("handles unwrapped messages response (raw array)", async () => {
    const client = makeMockClient({
      events: [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_raw",
              sessionID: sessionId,
              role: "assistant",
              time: { created: 1, completed: 2 },
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
            },
          },
        },
      ],
      messagesResp: [
        { info: { id: "msg_raw" }, parts: [{ type: "text", text: "raw" }] },
      ],
    });

    const { wait } = await openCompletionWaiter(client, sessionId, 5000);
    const completed = await wait;
    expect(completed.parts).toEqual([{ type: "text", text: "raw" }]);
  });
});
