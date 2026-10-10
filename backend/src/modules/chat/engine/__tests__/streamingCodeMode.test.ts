import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Code mode: the model sees `run_python` alone, a cell runs in a persistent
// Python kernel (here a local python3 process standing in for the VM), and
// every `await tools.x(...)` goes back through the turn's ordinary tool path.
// These pin the tool exposure, that cell calls reach the dispatcher, that the
// mutation gate holds inside Python, that variables outlive a turn, and that
// a question for the user pauses the turn.

type ToolCall = { id: string; function: { name: string; arguments: string } };

const { streamChatWithTools, runToolCalls } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
  runToolCalls: vi.fn(async (calls: ToolCall[]) => ({
    toolResults: calls.map((call) => ({
      role: "tool",
      tool_call_id: call.id,
      content:
        call.function.name === "find_in_document"
          ? JSON.stringify({ error: "document not found" })
          : JSON.stringify({ tool: call.function.name, args: JSON.parse(call.function.arguments) }),
    })),
    docsRead: [],
    docsFound: [],
    docsCreated: [],
    docsReplicated: [],
    workflowsApplied: [],
    docsEdited: [],
    askInputsEvents: calls
      .filter((call) => call.function.name === "ask_inputs")
      .map(() => ({ type: "ask_inputs", event_id: "e1", items: [{ kind: "text", id: "q", label: "Which year?" }] })),
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

import { kernels } from "../../../../lib/codemode";
import { runLLMStream } from "../streaming";
import { PROJECT_EXTRA_TOOLS } from "../tools/toolSchemas";

type RunToolsFn = (
  calls: { id: string; name: string; input: Record<string, unknown> }[],
) => Promise<{ tool_use_id: string; content: string }[]>;

type StreamChatCall = {
  tools: { function: { name: string } }[];
  systemPrompt: string;
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

const cell = (code: string, id = "p1") => ({ id, name: "run_python", input: { code } });

const kernelDir = mkdtempSync(path.join(tmpdir(), "mike-kernel-"));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODE_MODE_LOCAL_KERNEL_DIR", kernelDir);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => kernels.closeAll());

describe("code mode", () => {
  it("offers run_python alone, with every tool documented as Python", async () => {
    await runLLMStream(baseParams() as never);
    const offered = streamChatWithTools.mock.calls[0][0];
    expect(offered.tools.map((t) => t.function.name)).toEqual(["run_python"]);
    expect(offered.systemPrompt).toContain("TOOLS IN PYTHON:");
    expect(offered.systemPrompt).toMatch(/await tools\.read_document\(doc_id: str/);
    expect(offered.systemPrompt).toContain("await tools.list_documents(");

    vi.stubEnv("CODE_MODE_ENABLED", "false");
    await runLLMStream(baseParams() as never);
    const direct = streamChatWithTools.mock.calls[1][0];
    expect(direct.tools.map((t) => t.function.name)).not.toContain("run_python");
    expect(direct.tools.map((t) => t.function.name)).toContain("read_document");
    expect(direct.systemPrompt).not.toContain("TOOLS IN PYTHON:");
  });

  it("runs a guest's turn in the host's workstation, with direct tools until the host allows the thread", async () => {
    vi.stubEnv("WORKSTATION_USER_IDS", "host");
    vi.stubEnv("WORKSTATION_SSH_HOST", "127.0.0.1");
    vi.stubEnv("WORKSTATION_SSH_PORT", "2222");
    vi.stubEnv("WORKSTATION_SSH_IDENTITY_FILE", "/keys/dev");
    const guest = (standing: boolean | null) => ({
      ...baseParams(),
      userId: "guest",
      workstationUserId: "host",
      guestCode: standing === null ? null : { hostName: "Pat", standing, request: vi.fn() },
    });
    const names = (n: number) => streamChatWithTools.mock.calls[n][0].tools.map((t) => t.function.name);

    await runLLMStream(guest(false) as never);
    expect(names(0)).toContain("run_command");
    expect(names(0)).not.toContain("run_python");
    expect(streamChatWithTools.mock.calls[0][0].systemPrompt).toContain("Each run_command asks Pat for permission first");

    await runLLMStream(guest(true) as never);
    expect(names(1)).toEqual(["run_python"]);
    expect(streamChatWithTools.mock.calls[1][0].systemPrompt).toContain("Pat has allowed this user's messages to use it");

    // A surface that cannot ask the host gives a guest no workstation at all.
    await runLLMStream(guest(null) as never);
    expect(names(2)).not.toContain("run_command");
    expect(names(2)).not.toContain("run_python");
  });

  it("routes the cell's tool calls through the dispatcher", async () => {
    const [result] = await turn([
      cell(`docs = await tools.gather(*[tools.read_document(doc_id=i) for i in ["a", "b"]])
print("read", len(docs))
",".join(d["args"]["doc_id"] for d in docs)`),
    ]);
    expect(result.tool_use_id).toBe("p1");
    expect(result.content).toBe("read 2\n\n[result]\n'a,b'");
    const dispatched = runToolCalls.mock.calls.flatMap(([calls]) => calls.map((c) => c.function.name));
    expect(dispatched).toEqual(["read_document", "read_document"]);
  });

  it("streams the cell as a code_cell line, started and then finished", async () => {
    const write = vi.fn();
    await turn([cell("await tools.read_document(doc_id='a')\nprint('done')")], { write });
    const cells = write.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((chunk) => chunk.includes('"type":"code_cell"'))
      .map((chunk) => JSON.parse(chunk.slice(6)));
    expect(cells).toHaveLength(2);
    expect(cells[0]).toEqual({ type: "code_cell", call_id: "p1", code: "await tools.read_document(doc_id='a')\nprint('done')", status: "running" });
    expect(cells[1]).toMatchObject({ call_id: "p1", status: "ok", output: "done", tool_calls: 1 });
    expect(typeof cells[1].duration_ms).toBe("number");
  });

  it("raises ToolError for a tool that reports an error", async () => {
    const [result] = await turn([
      cell(`try:
    await tools.find_in_document(doc_id="a", query="x")
except ToolError as e:
    print("caught:", e)`),
    ]);
    expect(result.content).toBe("caught: find_in_document: document not found");
  });

  it("keeps the mutation gate inside Python", async () => {
    const [result] = await turn([cell(`("edit_document" in tools, "read_document" in tools)`)], {
      allowDocumentMutation: false,
    });
    expect(result.content).toBe("[result]\n(False, True)");
    const [refused] = await turn([cell(`await tools.edit_document({"doc_id": "a"})`)], { allowDocumentMutation: false });
    expect(refused.content).toMatch(/No tool named 'edit_document'/);
    expect(runToolCalls).not.toHaveBeenCalled();
  });

  it("answers cells in the model's call order alongside other calls", async () => {
    const results = await turn([
      { id: "c1", name: "read_document", input: { doc_id: "x" } },
      cell("1 + 1", "p1"),
      { id: "c2", name: "read_document", input: { doc_id: "y" } },
    ]);
    expect(results.map((r) => r.tool_use_id)).toEqual(["c1", "p1", "c2"]);
    expect(results[1].content).toBe("[result]\n2");
  });

  it("keeps variables across turns of one conversation, and resets on request", async () => {
    await turn([cell("total = 40")], { conversationId: "conv-vars" });
    const [again] = await turn([cell("total + 2")], { conversationId: "conv-vars" });
    expect(again.content).toBe("[result]\n42");
    const [other] = await turn([cell("'total' in globals()")], { conversationId: "conv-other" });
    expect(other.content).toBe("[result]\nFalse");
    const [reset] = await turn([{ ...cell("'total' in globals()"), input: { code: "'total' in globals()", reset: true } }], {
      conversationId: "conv-vars",
    });
    expect(reset.content).toBe("[result]\nFalse");
  });

  it("tells the next turn which names the session already holds", async () => {
    await turn([cell("import json\nrates = {'a': 1}\ndef helper(): pass")], { conversationId: "conv-names" });
    await vi.waitFor(() => expect(kernels.knownNames("conv-names")).toContain("rates"));
    await runLLMStream({ ...baseParams(), conversationId: "conv-names" } as never);
    const prompt = streamChatWithTools.mock.calls.at(-1)![0].systemPrompt;
    expect(prompt).toMatch(/already defines, from earlier in this conversation: helper, json, rates\.$/);
  });

  it("pauses the turn when a cell asks the user, keeping the cell's variables", async () => {
    const write = vi.fn();
    const results = await turn(
      [
        cell(`draft = "kept"
try:
    await tools.ask_inputs(items=[{"kind": "text", "id": "q", "label": "Which year?"}])
except Exception:
    print("must not swallow the pause")`),
      ],
      { conversationId: "conv-ask", write },
    );
    expect(results).toEqual([]);
    const frames = write.mock.calls.map(([chunk]) => String(chunk));
    expect(frames.some((frame) => frame.includes('"type":"ask_inputs"'))).toBe(true);
    const [next] = await turn([cell("draft")], { conversationId: "conv-ask" });
    expect(next.content).toBe("[result]\n'kept'");
  });

  it("reports a cell's error with its traceback, and the time limit", async () => {
    const [failed] = await turn([cell("def f():\n    return 1 / 0\nf()")]);
    expect(failed.content).toMatch(/^\[error\]\nTraceback[\s\S]*ZeroDivisionError: division by zero$/);
    const [slow] = await turn([{ id: "p1", name: "run_python", input: { code: "import time\ntime.sleep(30)", timeout_seconds: 1 } }]);
    expect(slow.content).toMatch(/KeyboardInterrupt[\s\S]*\[note\] the cell hit its time limit/);
  });
});
