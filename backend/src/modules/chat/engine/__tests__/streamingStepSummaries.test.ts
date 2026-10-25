import { afterEach, describe, expect, it, vi } from "vitest";

type Callbacks = { onReasoningDelta: (delta: string) => void; onReasoningBlockEnd: () => void };

const { streamChatWithTools, completeText } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: { callbacks: Callbacks }) => ({ fullText: "" })),
  completeText: vi.fn(async (_params: { user: string }) => "summary"),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: { callbacks: Callbacks }) => streamChatWithTools(params),
  completeText: (params: { user: string }) => completeText(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));
vi.mock("../tools/toolDispatcher", () => ({
  runToolCalls: vi.fn(),
}));
vi.mock("../../../user/user.service", () => ({
  getAutoModeDecisionModel: vi.fn(async () => null),
  getAutocompactTokensFor: vi.fn(async () => undefined),
}));

import { runLLMStream } from "../streaming";

const LONG = "Weighing whether the notice period in the lease matches the deed. ".repeat(6);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("runLLMStream step summaries", () => {
  it("names each thinking block, streams its summary and stores the run summary", async () => {
    vi.stubEnv("STEP_SUMMARY_MODEL", "opencode-go/summariser");
    streamChatWithTools.mockImplementationOnce(async ({ callbacks }) => {
      for (const text of [LONG, "Short.", LONG]) {
        callbacks.onReasoningDelta(text);
        callbacks.onReasoningBlockEnd();
      }
      return { fullText: "" };
    });
    completeText
      .mockResolvedValueOnce("Checked the notice period.")
      .mockResolvedValueOnce("Checked it again.")
      .mockResolvedValueOnce("Compared the notice periods twice.");
    const write = vi.fn();

    const { events } = await runLLMStream({
      model: "gemini-3-flash-preview",
      apiMessages: [{ role: "user", content: "Do the lease and deed agree?" }],
      docStore: new Map(),
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write,
    });

    const frames = write.mock.calls
      .map(([frame]) => String(frame))
      .filter((frame) => frame.startsWith("data: {"))
      .map((frame) => JSON.parse(frame.slice(6)));
    const ids = frames.filter((frame) => frame.type === "reasoning_block_end").map((frame) => frame.id);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(/^reasoning-[0-9a-f]{8}-1$/);
    expect(new Set(ids).size).toBe(3);
    expect(frames.filter((frame) => frame.type === "step_summary").map((frame) => frame.target.id)).toEqual([
      ids[0],
      ids[2],
    ]);
    expect(completeText.mock.calls[0]![0]).toMatchObject({ model: "opencode-go/summariser" });
    expect(completeText.mock.calls[0]![0].user).toContain("Do the lease and deed agree?");

    const reasoning = events.filter((event) => event.type === "reasoning");
    expect(reasoning.map((event) => event.summary?.text)).toEqual([
      "Checked the notice period.",
      undefined,
      "Checked it again.",
    ]);
    expect(events.find((event) => event.type === "run_summary")).toMatchObject({
      steps: 3,
      summary: { text: "Compared the notice periods twice.", source: "side_model" },
    });
  });

  it("writes no side summaries when the chat's provider has no summariser", async () => {
    streamChatWithTools.mockImplementationOnce(async ({ callbacks }) => {
      callbacks.onReasoningDelta(LONG);
      callbacks.onReasoningBlockEnd();
      return { fullText: "" };
    });
    const { events } = await runLLMStream({
      model: "gemini-3-flash-preview",
      apiMessages: [{ role: "user", content: "hello" }],
      docStore: new Map(),
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write: vi.fn(),
    });
    expect(completeText).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "reasoning", text: LONG, id: expect.stringMatching(/^reasoning-/) }]);
  });

  it("stops writing summaries once the turn fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("STEP_SUMMARY_MODEL", "opencode-go/summariser");
    let finishSummary: (text: string) => void = () => {};
    completeText.mockImplementationOnce(() => new Promise((resolve) => (finishSummary = resolve)));
    streamChatWithTools.mockImplementationOnce(async ({ callbacks }) => {
      callbacks.onReasoningDelta(LONG);
      callbacks.onReasoningBlockEnd();
      throw new Error("provider down");
    });
    const write = vi.fn();
    const failure = await runLLMStream({
      model: "gemini-3-flash-preview",
      apiMessages: [{ role: "user", content: "hello" }],
      docStore: new Map(),
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write,
    }).catch((error: { events: { type: string; summary?: unknown }[] }) => error);
    finishSummary("Too late.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(write.mock.calls.some(([frame]) => String(frame).includes("step_summary"))).toBe(false);
    expect((failure as { events: { type: string; summary?: unknown }[] }).events.find((event) => event.type === "reasoning")?.summary).toBeUndefined();
  });
});
