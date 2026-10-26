import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The person's computer in code mode: its functions are offered only while a
// helper is connected, a cell reaches them like any other tool, and the
// screenshot an observe took comes back on the cell's result as an image
// instead of through the kernel.

type ToolCall = { id: string; function: { name: string; arguments: string } };

const { streamChatWithTools, runToolCalls, online } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
  online: { value: true },
  runToolCalls: vi.fn(async (calls: ToolCall[]) => ({
    toolResults: calls.map((call) => ({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify({ ok: true, frame_id: "f1", has_screenshot: true }),
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
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools: vi.fn(async () => []) }));
vi.mock("../tools/toolDispatcher", () => ({ runToolCalls: (calls: ToolCall[]) => runToolCalls(calls) }));
vi.mock("../../../computers/computers.service", () => ({
  listOnlineDevices: async () =>
    online.value
      ? [{ id: "d1", name: "Studio Mac", platform: "linux", capabilities: { coordinates: "refs_only", takeover: "none", secure_input: "best_effort" } }]
      : [],
  takeComputerScreenshot: (callId: string) =>
    callId.endsWith(".1") ? { data: `shot-${callId}`, mimeType: "image/jpeg" } : null,
}));

import { kernels } from "../../../../lib/codemode";
import { runLLMStream } from "../streaming";

type RunToolsFn = (
  calls: { id: string; name: string; input: Record<string, unknown> }[],
) => Promise<{ tool_use_id: string; content: string; images?: { data: string; mimeType: string }[] }[]>;

type StreamChatCall = {
  tools: { function: { name: string } }[];
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
  };
}

async function turn(calls: Parameters<RunToolsFn>[0]) {
  let results: Awaited<ReturnType<RunToolsFn>> = [];
  streamChatWithTools.mockImplementationOnce(async (params: StreamChatCall) => {
    results = (await params.runTools?.(calls)) ?? [];
    return { fullText: "" };
  });
  await runLLMStream(baseParams() as never);
  return results;
}

const index = (call: StreamChatCall) => call.turnContext?.find((s) => s.key === "tool-index")?.text ?? "";

const kernelDir = mkdtempSync(path.join(tmpdir(), "mike-kernel-"));
beforeEach(() => {
  vi.clearAllMocks();
  online.value = true;
  vi.stubEnv("CODE_MODE_LOCAL_KERNEL_DIR", kernelDir);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => kernels.closeAll());

describe("the person's computer in code mode", () => {
  it("is offered only while a helper is connected", async () => {
    await runLLMStream(baseParams() as never);
    const offered = index(streamChatWithTools.mock.calls[0][0]);
    expect(offered).toContain("- computer_observe(");
    // The model learns each computer's name and limits.
    expect(offered).toContain("- Studio Mac (Linux): click and scroll by ref only");
    online.value = false;
    await runLLMStream(baseParams() as never);
    expect(index(streamChatWithTools.mock.calls[1][0])).not.toContain("computer_observe");
  });

  it("attaches the cell's screenshot to the run_python result, not the kernel's output", async () => {
    const [result] = await turn([
      { id: "p1", name: "run_python", input: { code: "r = await tools.computer_observe(screenshot=True)\nprint(r['frame_id'])" } },
    ]);
    expect(runToolCalls.mock.calls[0][0][0].function.name).toBe("computer_observe");
    expect(result.content).toContain("f1");
    expect(result.content).not.toContain("shot-");
    expect(result.images).toEqual([{ data: "shot-p1.1", mimeType: "image/jpeg" }]);
  });

  it("adds no image to a cell that took no screenshot", async () => {
    const [result] = await turn([{ id: "p2", name: "run_python", input: { code: "print(1 + 1)" } }]);
    expect(result.images).toBeUndefined();
  });
});
