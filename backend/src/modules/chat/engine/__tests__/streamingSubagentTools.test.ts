import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// A subagent works through run_python in a kernel of its own, and the calls
// its cells make run through the turn's own runner in its "child" scope.
// These pin what that scope changes: what reaches the user, the order of
// writes, and approvals.

type Call = { id: string; name: string; input: Record<string, unknown> };
type Spec = KernelToolSpec;
type ChildPython = (call: Call, kernel: { key: string; tools: Spec[] }) => Promise<string>;

const mocks = vi.hoisted(() => ({
  runPython: undefined as undefined | ChildPython,
  duringTurn: undefined as undefined | (() => Promise<void>),
  runToolCalls: vi.fn(),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: async () => {
    await mocks.duringTurn?.();
    return { fullText: "done" };
  },
}));
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools: vi.fn(async () => []) }));
vi.mock("../tools/toolDispatcher", () => ({ runToolCalls: mocks.runToolCalls }));
vi.mock("../subagents/subagentHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../subagents/subagentHost")>()),
  createSubagentHost: vi.fn(async (args: { runPython: ChildPython }) => {
    mocks.runPython = args.runPython;
    return { host: { toolDescription: "", prepare: vi.fn() }, promptSection: "SUBAGENTS:" };
  }),
}));

import { kernels, pythonToolSpecs, type KernelToolSpec } from "../../../../lib/codemode";
import { runLLMStream } from "../streaming";
import { TOOLS } from "../tools/toolSchemas";
import { localKernelDir } from "./pythonToolIndex";

/** A child's tools in its Python: the conversation's, and one connector. */
const CHILD_TOOLS: Spec[] = [
  ...pythonToolSpecs(TOOLS),
  { name: "mcp_gmail__send", description: "Send an email", parameters: { type: "object", properties: {} } },
];

/** One cell of the child `key`, in its own kernel; resolves with what its model reads. */
const childCell = (key: string, code: string) =>
  mocks.runPython!({ id: `${key}-cell`, name: "run_python", input: { code } }, { key, tools: CHILD_TOOLS });

const kernelDir = localKernelDir();
afterAll(() => kernels.closeAll());

const empty = {
  toolResults: [],
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
};

function params() {
  return {
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "hi" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    includeSubagents: true,
  };
}

beforeEach(() => {
  vi.stubEnv("CODE_MODE_LOCAL_KERNEL_DIR", kernelDir);
  mocks.runPython = undefined;
  mocks.duringTurn = undefined;
  mocks.runToolCalls.mockReset();
});

describe("a subagent's tool calls", () => {
  it("keep its reads out of the parent's timeline but show its edits", async () => {
    mocks.runToolCalls.mockImplementation(async (calls: { id: string; function: { name: string } }[], ...rest: unknown[]) => {
      const write = rest[3] as (chunk: string) => void;
      if (calls[0].function.name === "read_document") {
        write(`data: ${JSON.stringify({ type: "doc_read_start", filename: "NDA.docx" })}\n\n`);
        return { ...empty, toolResults: [{ tool_call_id: calls[0].id, content: "text" }], docsRead: [{ filename: "NDA.docx" }] };
      }
      write(`data: ${JSON.stringify({ type: "doc_edited_start", filename: "NDA.docx" })}\n\n`);
      return {
        ...empty,
        toolResults: [{ tool_call_id: calls[0].id, content: "edited" }],
        docsEdited: [{ filename: "NDA.docx", document_id: "d1", version_id: "v2", version_number: 2, download_url: "/d", annotations: [] }],
      };
    });
    const results: string[] = [];
    mocks.duringTurn = async () => {
      results.push(await childCell("child-a", `print(await tools.read_document(doc_id="doc-0"))`));
      results.push(await childCell("child-a", `print(await tools.edit_document(doc_id="doc-0", edits=[]))`));
    };
    const p = params();
    const result = await runLLMStream(p as never);

    expect(results).toEqual(["text", "edited"]);
    const types = result.events.map((event) => event.type);
    expect(types).toContain("doc_edited");
    expect(types).not.toContain("doc_read");
    // The child's cells are its own work: they are not lines in the parent's answer.
    expect(types).not.toContain("code_cell");
    const frames = p.write.mock.calls.map(([chunk]) => String(chunk));
    expect(frames.some((chunk) => chunk.includes('"doc_edited_start"'))).toBe(true);
    expect(frames.some((chunk) => chunk.includes('"doc_read_start"'))).toBe(false);
  });

  it("never asks the user to approve a connector call", async () => {
    mocks.runToolCalls.mockResolvedValue(empty);
    mocks.duringTurn = async () => {
      await childCell("child-b", "await tools.mcp_gmail__send()");
    };
    await runLLMStream(params() as never);
    const options = mocks.runToolCalls.mock.calls[0].at(-1) as { connectorApprovals: boolean };
    expect(options.connectorApprovals).toBe(false);
  });

  it("take turns when two subagents write at once, while their reads overlap", async () => {
    const log: string[] = [];
    mocks.runToolCalls.mockImplementation(async (calls: { id: string; function: { name: string; arguments: string } }[]) => {
      const id = String(JSON.parse(calls[0].function.arguments).doc_id);
      log.push(`start ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      log.push(`end ${id}`);
      return { ...empty, toolResults: [{ tool_call_id: calls[0].id, content: "ok" }] };
    });
    mocks.duringTurn = async () => {
      await Promise.all([
        childCell("child-w1", `await tools.edit_document(doc_id="w1", edits=[])`),
        childCell("child-w2", `await tools.edit_document(doc_id="w2", edits=[])`),
      ]);
      await Promise.all([
        childCell("child-w1", `await tools.read_document(doc_id="r1")`),
        childCell("child-w2", `await tools.read_document(doc_id="r2")`),
      ]);
    };
    await runLLMStream(params() as never);
    // Each child's writes wait for the other's; their reads run together.
    const [w1, w2, r1, r2] = ["w1", "w2", "r1", "r2"].map((id) => [log.indexOf(`start ${id}`), log.indexOf(`end ${id}`)]);
    const writesOverlap = w1![0]! < w2![1]! && w2![0]! < w1![1]!;
    expect(writesOverlap).toBe(false);
    expect(r1![0]! < r2![1]! && r2![0]! < r1![1]!).toBe(true);
  });
});
