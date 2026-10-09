import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Code mode: `run_script` runs model-written JavaScript in QuickJS, and every
// `tools.x(...)` it makes goes back through the turn's ordinary tool path.
// These pin that the script is offered only when enabled, that its calls
// reach the dispatcher, and that the mutation gate still applies inside it.

type ToolCall = { id: string; function: { name: string; arguments: string } };

const { streamChatWithTools, runToolCalls } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
  runToolCalls: vi.fn(async (calls: ToolCall[]) => ({
    toolResults: calls.map((call) => ({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify({ tool: call.function.name, args: JSON.parse(call.function.arguments) }),
    })),
    docsRead: [],
    docsFound: [],
    docsCreated: [],
    docsReplicated: [],
    workflowsApplied: [],
    docsEdited: [],
    askInputsEvents: [],
    courtlistenerEvents: [],
    caseCitationEvents: [],
    mcpEvents: [],
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
  runToolCalls: (calls: ToolCall[]) => runToolCalls(calls),
}));

import { runLLMStream } from "../streaming";
import { PROJECT_EXTRA_TOOLS } from "../tools/toolSchemas";

type RunToolsFn = (
  calls: { id: string; name: string; input: Record<string, unknown> }[],
) => Promise<{ tool_use_id: string; content: string }[]>;

type StreamChatCall = {
  tools: { function: { name: string } }[];
  runTools?: RunToolsFn;
  [key: string]: unknown;
};

function baseParams() {
  return {
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "hi" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    extraTools: PROJECT_EXTRA_TOOLS,
  };
}

/** Runs one turn whose model makes `calls`; returns the tool results. */
async function turn(calls: Parameters<RunToolsFn>[0], extra: Record<string, unknown> = {}) {
  let results: Awaited<ReturnType<RunToolsFn>> = [];
  streamChatWithTools.mockImplementationOnce(async (params: StreamChatCall) => {
    results = (await params.runTools?.(calls)) ?? [];
    return { fullText: "" };
  });
  await runLLMStream({ ...baseParams(), ...extra } as never);
  return results;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODE_MODE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("code mode", () => {
  it("is offered only when enabled", async () => {
    await runLLMStream(baseParams() as never);
    expect(streamChatWithTools.mock.calls[0][0].tools.map((t) => t.function.name)).toContain("run_script");
    vi.stubEnv("CODE_MODE_ENABLED", "");
    await runLLMStream(baseParams() as never);
    expect(streamChatWithTools.mock.calls[1][0].tools.map((t) => t.function.name)).not.toContain("run_script");
  });

  it("routes the script's tool calls through the dispatcher", async () => {
    const [result] = await turn([
      {
        id: "s1",
        name: "run_script",
        input: {
          code: `const docs = await Promise.all(["a", "b"].map((id) => tools.read_document({ doc_id: id })));
                 console.log("read", docs.length);
                 return docs.map((d) => d.args.doc_id).join(",");`,
        },
      },
    ]);
    expect(result.tool_use_id).toBe("s1");
    expect(JSON.parse(result.content)).toMatchObject({ result: "a,b", output: "read 2", tool_calls: 2 });
    const dispatched = runToolCalls.mock.calls.flatMap(([calls]) => calls.map((c) => c.function.name));
    expect(dispatched).toEqual(["read_document", "read_document"]);
  });

  it("keeps the mutation gate inside the script", async () => {
    const [result] = await turn(
      [{ id: "s1", name: "run_script", input: { code: `return [typeof tools.edit_document, await tools.read_document({ doc_id: "a" })];` } }],
      { allowDocumentMutation: false },
    );
    expect(JSON.parse(result.content).result[0]).toBe("undefined");
  });

  it("answers scripts in the model's call order alongside other calls", async () => {
    const results = await turn([
      { id: "c1", name: "read_document", input: { doc_id: "x" } },
      { id: "s1", name: "run_script", input: { code: "return 1" } },
      { id: "c2", name: "read_document", input: { doc_id: "y" } },
    ]);
    expect(results.map((r) => r.tool_use_id)).toEqual(["c1", "s1", "c2"]);
    expect(JSON.parse(results[1].content)).toMatchObject({ result: 1, tool_calls: 0 });
  });

  it("does not let a script start another script", async () => {
    const [result] = await turn([{ id: "s1", name: "run_script", input: { code: "return typeof tools.run_script" } }]);
    expect(JSON.parse(result.content).result).toBe("undefined");
  });
});
