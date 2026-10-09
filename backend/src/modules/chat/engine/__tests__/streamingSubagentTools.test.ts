import { beforeEach, describe, expect, it, vi } from "vitest";

// A subagent's tool calls run through the turn's own runner in its "child"
// scope. These pin what that scope changes: what reaches the user, the
// order of writes, and approvals.

type Call = { id: string; name: string; input: Record<string, unknown> };
type ChildRunner = (calls: Call[]) => Promise<{ tool_use_id: string; content: string }[]>;

const mocks = vi.hoisted(() => ({
  childRunner: undefined as undefined | ((calls: Call[]) => Promise<{ tool_use_id: string; content: string }[]>),
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
vi.mock("../subagents/subagentHost", () => ({
  createSubagentHost: vi.fn(async (args: { runTools: ChildRunner }) => {
    mocks.childRunner = args.runTools;
    return { host: { toolDescription: "", prepare: vi.fn() }, promptSection: "SUBAGENTS:" };
  }),
}));

import { runLLMStream } from "../streaming";

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
  mocks.childRunner = undefined;
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
    const results: unknown[] = [];
    mocks.duringTurn = async () => {
      results.push(await mocks.childRunner!([{ id: "r1", name: "read_document", input: { doc_id: "doc-0" } }]));
      results.push(await mocks.childRunner!([{ id: "e1", name: "edit_document", input: { doc_id: "doc-0" } }]));
    };
    const p = params();
    const result = await runLLMStream(p as never);

    expect(results).toEqual([[{ tool_use_id: "r1", content: "text" }], [{ tool_use_id: "e1", content: "edited" }]]);
    const types = result.events.map((event) => event.type);
    expect(types).toContain("doc_edited");
    expect(types).not.toContain("doc_read");
    const frames = p.write.mock.calls.map(([chunk]) => String(chunk));
    expect(frames.some((chunk) => chunk.includes('"doc_edited_start"'))).toBe(true);
    expect(frames.some((chunk) => chunk.includes('"doc_read_start"'))).toBe(false);
  });

  it("never asks the user to approve a connector call", async () => {
    mocks.runToolCalls.mockResolvedValue(empty);
    mocks.duringTurn = async () => {
      await mocks.childRunner!([{ id: "m1", name: "mcp_gmail__send", input: {} }]);
    };
    await runLLMStream(params() as never);
    const options = mocks.runToolCalls.mock.calls[0].at(-1) as { connectorApprovals: boolean };
    expect(options.connectorApprovals).toBe(false);
  });

  it("take turns when two subagents write at once, while their reads overlap", async () => {
    const log: string[] = [];
    mocks.runToolCalls.mockImplementation(async (calls: { id: string; function: { name: string } }[]) => {
      log.push(`start ${calls[0].id}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      log.push(`end ${calls[0].id}`);
      return { ...empty, toolResults: [{ tool_call_id: calls[0].id, content: "ok" }] };
    });
    mocks.duringTurn = async () => {
      await Promise.all([
        mocks.childRunner!([{ id: "w1", name: "edit_document", input: {} }]),
        mocks.childRunner!([{ id: "w2", name: "edit_document", input: {} }]),
      ]);
      await Promise.all([
        mocks.childRunner!([{ id: "r1", name: "read_document", input: {} }]),
        mocks.childRunner!([{ id: "r2", name: "read_document", input: {} }]),
      ]);
    };
    await runLLMStream(params() as never);
    expect(log).toEqual(["start w1", "end w1", "start w2", "end w2", "start r1", "start r2", "end r1", "end r2"]);
  });
});
