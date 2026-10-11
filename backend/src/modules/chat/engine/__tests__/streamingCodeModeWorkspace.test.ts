import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Code mode in the user's own workstation: before the turn's first cell,
// ~/mike and ~/skills are brought up to date, as they are before a
// run_command (goals/mission-16-documents-in-workstation.md). The kernel here
// is a local python3 standing in for the VM.

const { streamChatWithTools, syncWorkspaceOncePerTurn } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(),
  syncWorkspaceOncePerTurn: vi.fn(),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: unknown) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools: vi.fn(async () => []) }));
vi.mock("../../../workspace/workspace.service", () => ({ syncWorkspaceOncePerTurn }));

const kernelDir = mkdtempSync(path.join(tmpdir(), "mike-kernel-ws-"));
vi.mock("../../../../lib/codemode", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/codemode")>("../../../../lib/codemode");
  return { ...actual, kernelLauncherFor: () => actual.localKernelLauncher(kernelDir) };
});
vi.mock("../../../../lib/workstation", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/workstation")),
  resolveWorkstation: vi.fn(async () => ({ host: "vm", user: "agent", identityFile: "/keys/dev" })),
  snapshotOncePerTurn: vi.fn(async () => undefined),
}));

import { kernels } from "../../../../lib/codemode";
import { runLLMStream } from "../streaming";

type Call = { id: string; name: string; input: Record<string, unknown> };

async function turn(calls: Call[], extra: Record<string, unknown> = {}) {
  let results: { tool_use_id: string; content: string }[] = [];
  streamChatWithTools.mockImplementationOnce(async (params: { runTools: (c: Call[]) => Promise<typeof results> }) => {
    for (const call of calls) results.push(...(await params.runTools([call])));
    return { fullText: "" };
  });
  await runLLMStream({
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "hi" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    userEmail: "me@example.com",
    conversationId: `c-${Math.random()}`,
    db: {} as never,
    write: vi.fn(),
    ...extra,
  } as never);
  return results;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());
afterAll(() => kernels.closeAll());

describe("code mode and ~/mike", () => {
  it("syncs once per turn before the first cell", async () => {
    syncWorkspaceOncePerTurn.mockResolvedValue({ ok: true });
    const results = await turn([
      { id: "p1", name: "run_python", input: { code: "print(1)" } },
      { id: "p2", name: "run_python", input: { code: "print(2)" } },
    ]);
    expect(syncWorkspaceOncePerTurn).toHaveBeenCalledTimes(2);
    const [turnState, , user, target] = syncWorkspaceOncePerTurn.mock.calls[0]!;
    // Same per-turn object both times: the sync module runs it once.
    expect(syncWorkspaceOncePerTurn.mock.calls[1]![0]).toBe(turnState);
    expect(user).toEqual({ id: "u1", email: "me@example.com" });
    expect(target).toMatchObject({ host: "vm" });
    expect(results.map((r) => r.content)).toEqual(["1", "2"]);
  });

  it("says when the copy could not be brought up to date, and still runs the cell", async () => {
    syncWorkspaceOncePerTurn.mockResolvedValue({ ok: false, error: "workstation unreachable" });
    const [result] = await turn([{ id: "p1", name: "run_python", input: { code: "print('ran')" } }]);
    expect(result!.content).toMatch(/^\[note\] Your Mike documents and skills could not all be brought up to date/);
    expect(result!.content).toContain("ran");
  });
});
