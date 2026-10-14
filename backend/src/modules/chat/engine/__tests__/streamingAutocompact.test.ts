import { beforeEach, describe, expect, it, vi } from "vitest";

type StreamChatCall = { model: string; autocompactTokens?: number; [key: string]: unknown };

const { streamChatWithTools, getAutocompactTokensFor } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
  getAutocompactTokensFor: vi.fn(async (_db: unknown, _userId: string, _model: string): Promise<number | undefined> => undefined),
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
vi.mock("../../../user/user.service", () => ({
  getAutoModeDecisionModel: vi.fn(async () => null),
  getAutocompactTokensFor: (db: unknown, userId: string, model: string) =>
    getAutocompactTokensFor(db, userId, model),
}));

import { runLLMStream } from "../streaming";

function run() {
  return runLLMStream({
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "hello" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  streamChatWithTools.mockResolvedValue({ fullText: "" });
});

describe("runLLMStream auto-compact threshold", () => {
  it("passes the person's threshold for the turn's model", async () => {
    getAutocompactTokensFor.mockResolvedValueOnce(421_000);
    await run();
    expect(getAutocompactTokensFor).toHaveBeenCalledWith(expect.anything(), "u1", "gemini-3-flash-preview");
    expect(streamChatWithTools.mock.calls[0]![0].autocompactTokens).toBe(421_000);
  });

  it("leaves it unset when the person set nothing or it cannot be read", async () => {
    await run();
    expect("autocompactTokens" in streamChatWithTools.mock.calls[0]![0]).toBe(false);

    getAutocompactTokensFor.mockRejectedValueOnce(new Error("db down"));
    await run();
    expect("autocompactTokens" in streamChatWithTools.mock.calls[1]![0]).toBe(false);
  });
});
