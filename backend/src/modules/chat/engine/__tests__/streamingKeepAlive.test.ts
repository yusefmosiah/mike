import { afterEach, expect, it, vi } from "vitest";

// A turn that is working without output (a long tool call, a subagent, a
// wait for the thread's starter) must not look hung to the run's idle
// deadline: it sends a keep-alive comment while that work is under way, and
// nothing once it has stopped.

type ToolCall = { id: string; function: { name: string; arguments: string } };
type RunToolsFn = (calls: { id: string; name: string; input: Record<string, unknown> }[]) => Promise<unknown>;

const { streamChatWithTools, runToolCalls, release } = vi.hoisted(() => {
  let open: () => void = () => {};
  return {
    release: () => open(),
    streamChatWithTools: vi.fn(),
    runToolCalls: vi.fn(
      (calls: ToolCall[]) =>
        new Promise((resolve) => {
          open = () =>
            resolve({
              toolResults: calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: "{}" })),
              docsRead: [], docsFound: [], docsCreated: [], docsReplicated: [], workflowsApplied: [],
              docsEdited: [], askInputsEvents: [], courtlistenerEvents: [], caseCitationEvents: [], mcpEvents: [],
            });
        }),
    ),
  };
});

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: unknown) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools: vi.fn(async () => []) }));
vi.mock("../tools/toolDispatcher", () => ({ runToolCalls: (calls: ToolCall[]) => runToolCalls(calls) }));

import { KEEP_ALIVE_MS, runLLMStream } from "../streaming";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("keeps a turn alive while a tool works, and goes quiet once it is done", async () => {
  vi.useFakeTimers();
  vi.stubEnv("CODE_MODE_ENABLED", "false");
  const write = vi.fn();
  const keepAlives = () => write.mock.calls.filter(([chunk]) => String(chunk).startsWith(":")).length;
  let toolDone: Promise<unknown> = Promise.resolve();
  streamChatWithTools.mockImplementationOnce(async (params: { runTools: RunToolsFn }) => {
    toolDone = params.runTools([{ id: "c1", name: "list_documents", input: {} }]);
    await toolDone;
    return { fullText: "" };
  });
  const turn = runLLMStream({
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "hi" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write,
  } as never);

  await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 12);
  expect(keepAlives()).toBeGreaterThanOrEqual(11);

  release();
  await turn;
  const after = keepAlives();
  await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 4);
  expect(keepAlives()).toBe(after);
});

it("reports a stopped run as a stop, not a failure", async () => {
  vi.stubEnv("CODE_MODE_ENABLED", "false");
  const controller = new AbortController();
  streamChatWithTools.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error("The answer could not be completed (aborted)");
  });
  const turn = runLLMStream({
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "hi" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    signal: controller.signal,
  } as never);
  await expect(turn).rejects.toMatchObject({ name: "AbortError" });
});
