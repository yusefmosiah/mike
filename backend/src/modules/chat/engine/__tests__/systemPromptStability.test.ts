import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The system prompt must be byte-identical for the life of a chat. Providers
// reuse a prompt's processed prefix only while it is unchanged; a system
// prompt that moved from turn to turn made Pi write a new `pi.system` entry
// and re-prefill the whole conversation every turn. This builds the prompt
// for one chat across turns that differ in everything a turn can bring (its
// documents, the time, what the Python session defines, the tools on offer,
// the skills, memory's audience, the model) and diffs the two; everything that
// varies must arrive as turn context instead.

type Section = { key: string; text: string };
type StreamChatCall = {
  systemPrompt: string;
  turnContext?: Section[];
  tools: { function: { name: string } }[];
  [key: string]: unknown;
};

const { streamChatWithTools, mcpTools, memoryFiles } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
  mcpTools: { current: [] as unknown[] },
  memoryFiles: { current: "" },
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));

vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => mcpTools.current),
}));

vi.mock("../../../../lib/memory/files", () => ({
  getMemoryCurrent: vi.fn(async () => ({
    current: { enabled: !!memoryFiles.current, content: memoryFiles.current },
  })),
}));

vi.mock("../subagents/subagentHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../subagents/subagentHost")>()),
  createSubagentHost: vi.fn(async (args: { chatModel: string }) => ({
    host: {},
    promptSection: `SUBAGENTS:\nModels a subagent may run on (omit \`model\` to use ${args.chatModel}).`,
  })),
}));

import { kernels } from "../../../../lib/codemode";
import { buildMessages, buildUserPersonalisationPrompt, generateSpotlightNonce } from "../contextBuilders";
import { VOICE_PROMPT_SECTION } from "../prompts";
import { runLLMStream } from "../streaming";
import type { WorkflowStore } from "../types";

const kernelDir = mkdtempSync(path.join(tmpdir(), "mike-kernel-"));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODE_MODE_LOCAL_KERNEL_DIR", kernelDir);
  vi.stubEnv("SPOTLIGHT_NONCE_SECRET", "test-secret");
  mcpTools.current = [];
  memoryFiles.current = "";
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => kernels.closeAll());

const CHAT = "chat-stable";

type TurnShape = {
  documents: string[];
  now: Date;
  pythonNames: string[];
  connectorTool?: string;
  autoMode?: boolean;
  voice?: boolean;
  skills: string[];
  sharedAudience: boolean;
  memory: string;
  model: string;
  /** Who sent the turn: a shared chat has several people. */
  sender: string;
};

function skillStore(names: string[]): WorkflowStore {
  return new Map(
    names.map((name, i) => [
      `skill-${i}`,
      { title: name, name, skill_md: `# ${name}\nDo ${name}.`, description: `Use for ${name}.` },
    ]),
  );
}

/** Build and run one turn of the same chat, returning what reached the model runtime. */
async function runTurn(shape: TurnShape): Promise<StreamChatCall> {
  mcpTools.current = shape.connectorTool
    ? [{ type: "function", function: { name: shape.connectorTool, description: "A connector tool", parameters: { type: "object", properties: {} } } }]
    : [];
  memoryFiles.current = shape.memory;
  vi.spyOn(kernels, "knownNames").mockReturnValue(shape.pythonNames);
  const nonce = generateSpotlightNonce(CHAT);
  const personalisation = buildUserPersonalisationPrompt(
    { displayName: shape.sender, organisation: "Acme", jurisdiction: null, practiceSetting: null, professionalTitle: null, practiceAreas: [] },
    nonce,
  );
  const history = [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: `question at ${shape.now.toISOString()}` },
  ];
  const apiMessages = buildMessages(
    history,
    shape.documents.map((filename, i) => ({ doc_id: `doc-${i}`, filename })),
    undefined,
    undefined,
    true,
    nonce,
    "append",
    { timeZone: "Europe/Berlin", now: shape.now, userSentAt: [null, null] },
    personalisation,
  );
  await runLLMStream({
    apiMessages,
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    model: shape.model,
    conversationId: CHAT,
    workflowStore: skillStore(shape.skills),
    includeMemory: true,
    memorySharedAudience: shape.sharedAudience,
    includeSubagents: true,
    autoMode: shape.autoMode ?? false,
    voice: shape.voice ?? false,
    nonce,
  } as never);
  return streamChatWithTools.mock.calls.at(-1)![0];
}

const section = (call: StreamChatCall, key: string) => call.turnContext?.find((s) => s.key === key)?.text;

const TURN_ONE: TurnShape = {
  documents: ["lease.pdf"],
  now: new Date("2026-10-13T09:00:00Z"),
  pythonNames: [],
  skills: ["contract-review"],
  sharedAudience: false,
  memory: "",
  model: "gemini-3-flash-preview",
  sender: "Ada",
};

const TURN_TWO: TurnShape = {
  documents: ["lease.pdf", "board memo.docx"],
  now: new Date("2026-10-14T17:45:00Z"),
  pythonNames: ["rates", "helper"],
  connectorTool: "crm_lookup",
  autoMode: true,
  skills: ["contract-review", "nda-triage"],
  sharedAudience: true,
  memory: "# Project\n- Matter Alpha",
  model: "gpt-5.4",
  sender: "Grace",
};

describe("the chat system prompt", () => {
  it("is byte-identical across turns that differ in documents, time, Python names, tools, skills, memory, model and sender", async () => {
    const first = await runTurn(TURN_ONE);
    const second = await runTurn(TURN_TWO);
    // Code mode on both turns; the tool definitions the model sees are the same.
    expect(first.tools.map((t) => t.function.name)).toEqual(["run_python"]);
    expect(second.tools.map((t) => t.function.name)).toEqual(["run_python"]);
    expect(second.systemPrompt).toBe(first.systemPrompt);

    // A user with no workstation has no tools at all, and still the same
    // system prompt.
    vi.stubEnv("CODE_MODE_LOCAL_KERNEL_DIR", "");
    const toolless = await runTurn(TURN_TWO);
    expect(toolless.tools).toEqual([]);
    expect(section(toolless, "no-tools")).toContain("You have no tools in this conversation");
    expect(toolless.systemPrompt).toBe(first.systemPrompt);
  });

  it("names none of the turn's varying facts", async () => {
    const { systemPrompt } = await runTurn(TURN_TWO);
    for (const varying of ["board memo.docx", "lease.pdf", "rates, helper", "crm_lookup", "nda-triage", "gpt-5.4", "Matter Alpha", "AUDIENCE: SHARED", "2026", "Grace", "USER PERSONALISATION"]) {
      expect(systemPrompt).not.toContain(varying);
    }
    // The fixed parts stay: the surface's prompt, the language rule, turn context and memory policy.
    expect(systemPrompt).toContain("RESPONSE LANGUAGE:");
    expect(systemPrompt).toContain("TURN CONTEXT:");
    expect(systemPrompt).toContain("PERSISTED MEMORY POLICY:");
  });

  it("carries what it left out as turn context", async () => {
    const call = await runTurn(TURN_TWO);
    expect(call.turnContext!.map((s) => s.key)).toEqual([
      "documents",
      "personalisation",
      "memory-audience",
      "skills",
      "code-mode",
      "python-session",
      "subagents",
    ]);
    expect(section(call, "documents")).toContain("AVAILABLE DOCUMENTS:");
    expect(section(call, "documents")).toContain("doc-1:");
    expect(section(call, "personalisation")).toContain("USER PERSONALISATION:");
    expect(section(call, "personalisation")).toContain('"name": "Grace"');
    expect(section(call, "documents")).toContain("board memo.docx");
    expect(section(call, "memory-audience")).toContain("CURRENT MEMORY AUDIENCE: SHARED");
    expect(section(call, "skills")).toContain("nda-triage");
    expect(section(call, "code-mode")).toContain("TOOLS IN PYTHON:");
    expect(section(call, "code-mode")).toContain("await tools.crm_lookup(");
    expect(section(call, "python-session")).toContain("rates, helper");
    expect(section(call, "subagents")).toContain("gpt-5.4");
    // Memory's own content is the thread's first user message, never turn context.
    expect(call.turnContext!.map((s) => s.text).join("\n")).not.toContain("Matter Alpha");
    // The time is stamped on the user's message.
    const latest = (call.messages as { role: string; content: string }[]).at(-1)!;
    expect(latest.content).toMatch(/^\[Sent: .*2026/);
  });

  it("asks a voice turn for spoken answers as turn context, leaving the system prompt unchanged", async () => {
    const typed = await runTurn(TURN_ONE);
    const spoken = await runTurn({ ...TURN_ONE, voice: true });
    expect(spoken.systemPrompt).toBe(typed.systemPrompt);
    expect(spoken.systemPrompt).not.toContain("VOICE CONVERSATION:");
    expect(section(spoken, "voice")).toBe(VOICE_PROMPT_SECTION);
    expect(section(typed, "voice")).toBeUndefined();
  });
});
