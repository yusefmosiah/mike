import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createMikeModels } from "./providers.mjs";
import {
  finishTurnOnPi,
  interruptedTurnsOnPi,
  MAX_CONCURRENT_SUBAGENTS,
  MAX_SUBAGENTS_PER_TURN,
  resetPiRuntime,
  streamChatWithToolsOnPi,
  subagentTranscriptOnPi,
} from "./runtime.mjs";
import type { NormalizedToolCall, OpenAIToolSchema, StreamChatParams, SubagentHost, SubagentSpec } from "../types.js";

const MODEL = "opencode-go/test-model";
const CHILD_MARK = "You are a document reviewer";
/** Every child task starts with this, which is how the scripted model knows it is a child. */
const CHILD_TASK = "Find the governing law";

/** A tool the test's children use; registered by being among the parent's tools. */
const readDocument: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "read_document",
    description: "Read a document",
    parameters: { type: "object", properties: { doc_id: { type: "string" } }, required: ["doc_id"] },
  },
};

/** The parent's one tool, standing in for run_python: each task is a `tools.delegate` its code makes. */
const runCode: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "run_python",
    description: "Run code",
    parameters: { type: "object", properties: { tasks: { type: "array", items: { type: "string" } } }, required: ["tasks"] },
  },
};

type Ctx = { messages: readonly { role: string; content?: unknown }[] };
const text = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { type: string; text?: string }) => part.text ?? "").join("")
      : "";

/** Requests each side made, as the scripted model saw them. */
let childRequests: Ctx[];
let parentRequests: Ctx[];

/**
 * The scripted model. As the parent it runs code that delegates (as often as
 * the prompt says, gathering several tasks in one cell when it says "in
 * parallel") and then answers from the reports; as a child it reads one
 * document and reports what it found.
 */
function setup() {
  childRequests = [];
  parentRequests = [];
  const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "test-model", input: ["text"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const respond = (ctx: Ctx) => {
    const last = ctx.messages.at(-1);
    const firstUser = text(ctx.messages.find((m) => m.role === "user")?.content);
    if (firstUser.startsWith(CHILD_TASK)) {
      childRequests.push(ctx);
      if (last?.role === "user") {
        // A child told to delegate tries to, from its own code.
        const call = firstUser.includes("(nested)")
          ? fauxToolCall("run_python", { tasks: [`${CHILD_TASK} again`] })
          : fauxToolCall("read_document", { doc_id: "doc-0" });
        return fauxAssistantMessage([call], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage([fauxText(`Finding: ${text(last?.content)}`)]);
    }
    parentRequests.push(ctx);
    const delegations = ctx.messages.filter((m) => m.role === "toolResult").length;
    const together = Number(/in parallel (\d+)/.exec(firstUser)?.[1] ?? "0");
    if (together && delegations === 0) {
      // One cell gathering several children at once.
      return fauxAssistantMessage(
        [fauxToolCall("run_python", { tasks: Array.from({ length: together }, (_, i) => `${CHILD_TASK} (${i + 1})`) })],
        { stopReason: "toolUse" },
      );
    }
    const wanted = Number(/delegate (\d+)/.exec(firstUser)?.[1] ?? "1");
    if (delegations < wanted) {
      const task = firstUser.includes("nested") ? `${CHILD_TASK} (nested)` : `${CHILD_TASK} (${delegations + 1})`;
      return fauxAssistantMessage([fauxToolCall("run_python", { tasks: [task] })], { stopReason: "toolUse" });
    }
    const reports = ctx.messages.filter((m) => m.role === "toolResult").map((m) => text(m.content));
    return fauxAssistantMessage([fauxText(`Parent answer. ${reports.at(-1) ?? ""}`)]);
  };
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  // A restart is a new Harness over the same data, as a database outlives
  // its process: the storage ignores the old Harness closing it.
  const storage = new MemoryStorage();
  const surviving = new Proxy(storage, {
    get(target, key) {
      if (key === "close") return async () => undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { models: createMikeModels(models), storage: surviving };
}

function spec(overrides: Partial<SubagentSpec> = {}): SubagentSpec {
  return {
    type: "document_review",
    model: MODEL,
    instructions: `${CHILD_MARK}. Report with quotes.`,
    tools: ["read_document"],
    task: "Find the governing law",
    maxRounds: 4,
    maxOutputTokens: 10_000,
    timeoutMs: 30_000,
    runTools: async (calls) => calls.map((call) => ({ tool_use_id: call.id, content: "Clause 12: governed by Delaware law." })),
    ...overrides,
  };
}

// started/finished stay the test's own mocks, so their calls can be read back.
function host(overrides: Partial<Omit<SubagentHost, "started" | "finished">> = {}) {
  return {
    toolDescription: "Delegate (test).",
    prepare: vi.fn(async (input: Record<string, unknown>) => spec({ task: String(input.task) })),
    started: vi.fn(),
    finished: vi.fn(),
    ...overrides,
  } satisfies SubagentHost;
}

/** What the parent's code does with each task: `tools.delegate`, gathered. */
async function runCodeCalls(calls: NormalizedToolCall[]) {
  return Promise.all(
    calls.map(async (call) => {
      const tasks = (call.input.tasks as string[]) ?? [];
      if (!call.delegate) return { tool_use_id: call.id, content: "Delegation is not available here." };
      const reports = await Promise.all(tasks.map((task) => call.delegate!({ type: "document_review", task })));
      return { tool_use_id: call.id, content: reports.map((report) => report.content).join("\n\n") };
    }),
  );
}

async function parentTurn(prompt: string, extra: Partial<StreamChatParams> = {}) {
  const parentRunTools = vi.fn(runCodeCalls);
  const result = await streamChatWithToolsOnPi({
    conversationId: "chat-1",
    model: MODEL,
    systemPrompt: "You are Mike.",
    messages: [{ role: "user", content: prompt }],
    tools: [runCode, readDocument],
    turn: { userMessageId: "u1", parentMessageId: null, assistantMessageId: "a1" },
    runTools: parentRunTools,
    ...extra,
  });
  return { result, parentRunTools };
}

let current: ReturnType<typeof setup>;
beforeEach(async () => {
  current = setup();
  await resetPiRuntime(current);
});
afterEach(async () => {
  await resetPiRuntime();
});

describe("delegate", () => {
  it("runs a child on its own tools and model, and the parent answers from its report", async () => {
    const delegation = host();
    const { result, parentRunTools } = await parentTurn("Review the NDA", { subagents: delegation });

    expect(result.fullText).toContain("Parent answer.");
    expect(result.fullText).toContain("Delaware");
    // The parent's code ran once; the child's read went to the child's own runner.
    expect(parentRunTools).toHaveBeenCalledTimes(1);
    // The child starts from its task alone, none of the parent's conversation.
    const childUsers = childRequests[0].messages.filter((m) => m.role === "user");
    expect(childUsers.map((m) => text(m.content))).toEqual(["Find the governing law (1)"]);
    expect(childRequests[0].messages.some((m) => text(m.content).includes("Review the NDA"))).toBe(false);

    expect(delegation.started).toHaveBeenCalledWith(
      expect.objectContaining({ type: "document_review", model: MODEL, address: "turn/a1/document_review-1" }),
    );
    expect(delegation.finished).toHaveBeenCalledWith(
      expect.objectContaining({ status: "done", report: expect.stringContaining("Delaware") }),
    );
    const { childId, usage } = delegation.finished.mock.calls[0][0];
    expect(usage.output).toBeGreaterThan(0);
    // The parent's own spend is measured apart from the child's.
    expect(result.usage?.output).toBeGreaterThan(0);

    const transcript = await subagentTranscriptOnPi(childId);
    expect(transcript).toMatchObject({ chatKey: "chat-1", turnKey: "a1", status: "done", type: "document_review" });
    expect(transcript!.entries.map((entry) => entry.kind)).toEqual(["task", "assistant", "tool_result", "assistant"]);
    expect(transcript!.envelopes.map((envelope) => [envelope.kind, envelope.from, envelope.to])).toEqual([
      ["task", "turn/a1", "turn/a1/document_review-1"],
      ["report", "turn/a1/document_review-1", "turn/a1"],
    ]);
  });

  it("gives the model the host's refusal and starts no child", async () => {
    const delegation = host({ prepare: vi.fn(async () => 'Model "x" is not available to this user.') });
    const { result } = await parentTurn("Review the NDA", { subagents: delegation });
    expect(result.fullText).toContain('Model "x" is not available');
    expect(childRequests).toHaveLength(0);
    expect(delegation.started).not.toHaveBeenCalled();
  });

  it("gives code no way to delegate without a host", async () => {
    const { result } = await parentTurn("Review the NDA");
    expect(result.fullText).toContain("Delegation is not available here.");
    expect(childRequests).toHaveLength(0);
  });

  it("never lets a child delegate (depth 1)", async () => {
    const delegation = host({
      prepare: vi.fn(async (input: Record<string, unknown>) =>
        spec({ task: String(input.task), tools: ["run_python"], runTools: runCodeCalls }),
      ),
    });
    const { result } = await parentTurn("Review the NDA, nested", { subagents: delegation });
    expect(delegation.started).toHaveBeenCalledTimes(1);
    expect(result.fullText).toContain("Delegation is not available here.");
  });

  it(`starts at most ${MAX_SUBAGENTS_PER_TURN} children in one turn`, async () => {
    const delegation = host();
    const { result } = await parentTurn(`Review it, delegate ${MAX_SUBAGENTS_PER_TURN + 1}`, {
      subagents: delegation,
      maxIterations: 20,
    });
    expect(delegation.started).toHaveBeenCalledTimes(MAX_SUBAGENTS_PER_TURN);
    expect(result.fullText).toContain(`already started ${MAX_SUBAGENTS_PER_TURN} subagents`);
  });

  it("holds a child to its output budget: past it, its tools answer \"report now\"", async () => {
    const runTools = vi.fn(async (calls: { id: string }[]) => calls.map((call) => ({ tool_use_id: call.id, content: "never" })));
    const delegation = host({ prepare: vi.fn(async () => spec({ maxOutputTokens: 1, runTools })) });
    await parentTurn("Review the NDA", { subagents: delegation });
    expect(runTools).not.toHaveBeenCalled();
    expect(text(childRequests.at(-1)!.messages.at(-1)!.content)).toContain("used your 1 output tokens");
  });

  it("a refused call takes no slot and no number: the next child is still the first", async () => {
    let calls = 0;
    const delegation = host({
      prepare: vi.fn(async (input: Record<string, unknown>) =>
        ++calls === 1 ? 'Model "x" is not available to this user.' : spec({ task: String(input.task) }),
      ),
    });
    await parentTurn("Review it, delegate 2", { subagents: delegation });
    expect(delegation.started).toHaveBeenCalledTimes(1);
    expect(delegation.started).toHaveBeenCalledWith(expect.objectContaining({ address: "turn/a1/document_review-1" }));
  });

  it("refused calls do not use up the per-turn cap", async () => {
    let calls = 0;
    const delegation = host({
      prepare: vi.fn(async (input: Record<string, unknown>) =>
        ++calls <= MAX_SUBAGENTS_PER_TURN ? "Refused." : spec({ task: String(input.task) }),
      ),
    });
    await parentTurn(`Review it, delegate ${MAX_SUBAGENTS_PER_TURN + 1}`, { subagents: delegation, maxIterations: 20 });
    expect(delegation.started).toHaveBeenCalledTimes(1);
  });

  it("a turn cut off by a restart while its child works does not start it again", async () => {
    const durableTurn = { context: { surface: "chat" } };
    // The process dies while the child's read runs: it never returns.
    const hung = host({ prepare: vi.fn(async (input) => spec({ task: String(input.task), runTools: () => new Promise(() => undefined) })) });
    void parentTurn("Review the NDA", { subagents: hung, durableTurn }).catch(() => undefined);
    for (let i = 0; i < 50 && hung.started.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(hung.started).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await resetPiRuntime(current); // same storage, new process

    expect(await interruptedTurnsOnPi()).toEqual([expect.objectContaining({ assistantMessageId: "a1" })]);
    const delegation = host();
    const { result } = await parentTurn("Review the NDA", {
      subagents: delegation,
      durableTurn: { ...durableTurn, resume: true },
    });
    // The code that started it had effects, so it is answered as interrupted,
    // not run again: no second child.
    expect(delegation.started).not.toHaveBeenCalled();
    expect(result.fullText).toContain("Parent answer.");
    await finishTurnOnPi("a1");
  });

  it("runs the children one cell gathers at the same time", async () => {
    let running = 0;
    let peak = 0;
    const runTools = async (calls: { id: string }[]) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 50));
      running -= 1;
      return calls.map((call) => ({ tool_use_id: call.id, content: "Clause 12: governed by Delaware law." }));
    };
    const delegation = host({ prepare: vi.fn(async (input) => spec({ task: String(input.task), runTools })) });
    const { result } = await parentTurn("Review three contracts in parallel 3", { subagents: delegation });
    expect(peak).toBe(3);
    expect(delegation.finished).toHaveBeenCalledTimes(3);
    expect(result.fullText).toContain("Parent answer.");
    // Each child kept its own number.
    expect(delegation.started.mock.calls.map(([child]) => child.address).sort()).toEqual([
      "turn/a1/document_review-1",
      "turn/a1/document_review-2",
      "turn/a1/document_review-3",
    ]);
  });

  it(`runs at most ${MAX_CONCURRENT_SUBAGENTS} children at once, and tells the model to wait for the rest`, async () => {
    const delegation = host({
      prepare: vi.fn(async (input) =>
        spec({
          task: String(input.task),
          runTools: async (calls) => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return calls.map((call) => ({ tool_use_id: call.id, content: "Clause 12: governed by Delaware law." }));
          },
        }),
      ),
    });
    const { result } = await parentTurn(`Review them in parallel ${MAX_CONCURRENT_SUBAGENTS + 2}`, { subagents: delegation });
    expect(delegation.started).toHaveBeenCalledTimes(MAX_CONCURRENT_SUBAGENTS);
    const lastParent = parentRequests.at(-1)!;
    const cell = lastParent.messages.filter((m) => m.role === "toolResult").map((m) => text(m.content)).join("\n");
    expect(cell.match(/already running/g)).toHaveLength(2);
    expect(result.fullText).toContain("Parent answer.");
  });

  it("knows no subagent by a malformed or unknown id", async () => {
    expect(await subagentTranscriptOnPi("not-a-number")).toBeNull();
    expect(await subagentTranscriptOnPi("99999")).toBeNull();
  });
});
