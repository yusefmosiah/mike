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
  turnContext?: { key: string; text: string }[];
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

/** One turn context section of a call, or undefined when the turn has none. */
const section = (call: StreamChatCall, key: string) => call.turnContext?.find((s) => s.key === key)?.text;

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
    // The tool index is turn context; the system prompt never mentions it.
    expect(offered.systemPrompt).not.toContain("TOOLS IN PYTHON:");
    expect(section(offered, "code-mode")).toContain("TOOLS IN PYTHON:");
    expect(section(offered, "code-mode")).toMatch(/await tools\.read_document\(doc_id: str/);
    expect(section(offered, "code-mode")).toContain("await tools.list_documents(");

    // Without a workstation there is nothing to run code in, so no tools.
    vi.stubEnv("CODE_MODE_LOCAL_KERNEL_DIR", "");
    await runLLMStream(baseParams() as never);
    const none = streamChatWithTools.mock.calls[1][0];
    expect(none.tools).toEqual([]);
    expect(section(none, "code-mode")).toBeUndefined();
    expect(section(none, "no-tools")).toContain("You have no tools in this conversation");
    expect(none.systemPrompt).toBe(offered.systemPrompt);
  });

  it("puts memory and delegation in Python, never beside run_python", async () => {
    await runLLMStream({
      ...baseParams(),
      includeMemory: true,
      memoryEdit: { surface: "chat", conversationId: "c1", appWritable: true, projectId: null },
    } as never);
    const offered = streamChatWithTools.mock.calls[0][0];
    expect(offered.tools.map((t) => t.function.name)).toEqual(["run_python"]);
    expect(section(offered, "code-mode")).toContain("await tools.read_memory()");
    expect(section(offered, "code-mode")).toContain("await tools.edit_memory(scope: ");
  });

  it("answers tools.delegate with the subagent's report, through the call that ran the cell", async () => {
    const delegate = vi.fn(async (input: Record<string, unknown>) => ({ content: `Report on ${String(input.task)}`, isError: false }));
    let results: Awaited<ReturnType<RunToolsFn>> = [];
    streamChatWithTools.mockImplementationOnce(async (params: StreamChatCall) => {
      results = (await params.runTools?.([
        { ...cell(`print(await tools.delegate(type="general", task="the lease"))`), delegate } as never,
      ])) ?? [];
      return { fullText: "" };
    });
    await runLLMStream({ ...baseParams(), includeSubagents: true } as never);
    expect(delegate).toHaveBeenCalledWith({ type: "general", task: "the lease" });
    expect(results[0]!.content).toBe("Report on the lease");
  });

  it("runs gathered delegates at once, and their wait does not count against the cell's time", async () => {
    const delegate = vi.fn(async (input: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return { content: `Report on ${String(input.task)}`, isError: false };
    });
    const code = [
      `a, b = await tools.gather(tools.delegate(type="general", task="A"), tools.delegate(type="general", task="B"))`,
      `print(a, "|", b)`,
    ].join("\n");
    const started = Date.now();
    const [result] = await turn([{ ...cell(code), input: { code, timeout_seconds: 1 }, delegate } as never], {
      includeSubagents: true,
    });
    expect(result!.content).toBe("Report on A | Report on B");
    expect(delegate).toHaveBeenCalledTimes(2);
    // Both waited 1.5 s together, past the cell's 1 s.
    expect(Date.now() - started).toBeLessThan(2_900);
  });

  it("raises a refused delegate as a ToolError the cell can catch", async () => {
    const delegate = vi.fn(async () => ({ content: "Not run: 4 subagents are already running.", isError: true }));
    const code = [
      `try:`,
      `    await tools.delegate(type="general", task="A")`,
      `except ToolError as e:`,
      `    print("refused:", e)`,
    ].join("\n");
    const [result] = await turn([{ ...cell(code), delegate } as never], { includeSubagents: true });
    expect(result!.content).toContain("refused: delegate: Not run: 4 subagents are already running.");
  });

  it("ends a cell waiting on a delegate when the turn is stopped", async () => {
    const controller = new AbortController();
    const delegate = vi.fn(() => {
      setTimeout(() => controller.abort(), 200);
      return new Promise<{ content: string; isError: boolean }>(() => {});
    });
    const started = Date.now();
    const run = turn([{ ...cell(`await tools.delegate(type="general", task="A")`), delegate } as never], {
      includeSubagents: true,
      signal: controller.signal,
    });
    await run.catch(() => undefined);
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("runs a guest's turn in the host's workstation, asking the host before the first cell until they allow the thread", async () => {
    vi.stubEnv("WORKSTATION_USER_IDS", "host");
    vi.stubEnv("WORKSTATION_SSH_HOST", "127.0.0.1");
    vi.stubEnv("WORKSTATION_SSH_PORT", "2222");
    vi.stubEnv("WORKSTATION_SSH_IDENTITY_FILE", "/keys/dev");
    const request = vi.fn(async () => "denied" as const);
    const guest = (standing: boolean | null) => ({
      ...baseParams(),
      userId: "guest",
      workstationUserId: "host",
      guestCode: standing === null ? null : { hostName: "Pat", standing, request },
    });
    const names = (n: number) => streamChatWithTools.mock.calls[n][0].tools.map((t) => t.function.name);

    // Not yet allowed: the host is asked before the cell runs, and a refusal
    // is the cell's answer.
    const [refused] = await turn([cell("print('hi')")], guest(false));
    expect(names(0)).toEqual(["run_python"]);
    expect(section(streamChatWithTools.mock.calls[0][0], "workstation")).toContain("The first run_python in each message asks Pat for permission");
    expect(request).toHaveBeenCalledTimes(1);
    expect(refused.content).toMatch(/^\[error\]\nPat did not allow running code/);

    await runLLMStream(guest(true) as never);
    expect(names(1)).toEqual(["run_python"]);
    expect(section(streamChatWithTools.mock.calls[1][0], "workstation")).toContain("Pat has allowed this user's messages to use it");
    expect(streamChatWithTools.mock.calls[1][0].systemPrompt).toBe(streamChatWithTools.mock.calls[0][0].systemPrompt);

    // A surface that cannot ask the host gives a guest no workstation at all.
    await runLLMStream(guest(null) as never);
    expect(names(2)).toEqual([]);
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
    const call = streamChatWithTools.mock.calls.at(-1)![0];
    expect(section(call, "python-session")).toMatch(/already defines, from earlier in this conversation: helper, json, rates\.$/);
    expect(call.systemPrompt).not.toContain("helper, json, rates");
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
