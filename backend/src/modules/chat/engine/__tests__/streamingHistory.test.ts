import { beforeEach, describe, expect, it, vi } from "vitest";

// Declaring the stub's parameter (rather than a zero-arity `vi.fn`) is what
// lets tsc check the `mock.calls[0][0]` lookup below; with an empty call tuple
// every assertion on it type-checks vacuously.
type StreamChatCall = {
  systemPrompt: string;
  messages: { role: string; content: string }[];
  [key: string]: unknown;
};

const { streamChatWithTools } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({
    fullText: "",
  })),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));
vi.mock("../tools/toolDispatcher", () => ({
  runToolCalls: vi.fn(),
}));

import { runLLMStream } from "../streaming";

beforeEach(() => {
  vi.clearAllMocks();
  streamChatWithTools.mockResolvedValue({ fullText: "" });
});

describe("runLLMStream history", () => {
  it("drops assistant turns that carry no text so no provider sees an empty block", async () => {
    // A cancelled or errored turn, or a client that keeps prose in events,
    // replays as content "". Anthropic rejects the whole request over one
    // such block ("text content blocks must be non-empty").
    await runLLMStream({
      model: "gemini-3-flash-preview",
      apiMessages: [
        { role: "system", content: "SYSTEM" },
        { role: "user", content: "first" },
        { role: "assistant", content: "" },
        { role: "user", content: "second" },
        { role: "assistant", content: "kept" },
        { role: "user", content: "third" },
      ],
      docStore: new Map(),
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write: vi.fn(),
    });
    const params = streamChatWithTools.mock.calls[0]![0];
    // With the empty turn gone, the two prompts it separated arrive as one.
    expect(params.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "first\n\n---\n\nsecond"],
      ["assistant", "kept"],
      ["user", "third"],
    ]);
  });

  it("joins back-to-back user messages (/nr notes) into one turn for every provider", async () => {
    await runLLMStream({
      model: "gemini-3-flash-preview",
      apiMessages: [
        { role: "user", content: "Draft the letter." },
        { role: "assistant", content: "Done." },
        { role: "user", content: "Client called: cap at 1x fees." },
        { role: "user", content: "Also, Friday deadline." },
        { role: "user", content: "Update the letter." },
      ],
      docStore: new Map(),
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write: vi.fn(),
    });
    const params = streamChatWithTools.mock.calls[0]![0];
    expect(params.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Draft the letter."],
      ["assistant", "Done."],
      ["user", "Client called: cap at 1x fees.\n\n---\n\nAlso, Friday deadline.\n\n---\n\nUpdate the letter."],
    ]);
  });
});
