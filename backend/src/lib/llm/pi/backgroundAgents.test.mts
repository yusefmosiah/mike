import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createMikeModels } from "./providers.mjs";
import {
  MAX_WORKING_AGENTS_PER_CHAT,
  chatsWithAgentMessagesOnPi,
  resetPiRuntime,
  setAgentMessageSink,
  streamChatWithToolsOnPi,
  subagentTranscriptOnPi,
  takeAgentMessagesOnPi,
} from "./runtime.mjs";
import type { NormalizedToolCall, OpenAIToolSchema, SubagentHost, SubagentSpec } from "../types.js";

const MODEL = "opencode-go/test-model";
const CHILD_TASK = "Find the governing law";

const readDocument: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "read_document",
    description: "Read a document",
    parameters: { type: "object", properties: { doc_id: { type: "string" } }, required: ["doc_id"] },
  },
};

/** The parent's one tool, standing in for run_python: what its code does is the test's `code`. */
const runCode: OpenAIToolSchema = {
  type: "function",
  function: { name: "run_python", description: "Run code", parameters: { type: "object", properties: {} } },
};

type Ctx = { messages: readonly { role: string; content?: unknown }[] };
const text = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { type: string; text?: string }) => part.text ?? "").join("")
      : "";

let childRequests: Ctx[];

/**
 * The scripted model. As the parent it runs its code once and answers with
 * the cell's output. As a child, given its task it reads one document and
 * reports; given a message it answers it directly.
 */
function setup() {
  childRequests = [];
  const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "test-model", input: ["text"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const respond = (ctx: Ctx) => {
    const last = ctx.messages.at(-1);
    const firstUser = text(ctx.messages.find((m) => m.role === "user")?.content);
    if (firstUser.startsWith(CHILD_TASK)) {
      childRequests.push(ctx);
      if (last?.role === "user" && text(last.content).startsWith("<message")) {
        const messages = ctx.messages.filter((m) => m.role === "user" && text(m.content).startsWith("<message")).length;
        return fauxAssistantMessage([fauxText(`Reply ${messages}: ${text(last.content)}`)]);
      }
      if (last?.role === "user") {
        return fauxAssistantMessage([fauxToolCall("read_document", { doc_id: "doc-0" })], { stopReason: "toolUse" });
      }
      const heard = ctx.messages.filter((m) => m.role === "user" && text(m.content).startsWith("<message")).map((m) => text(m.content));
      return fauxAssistantMessage([fauxText(`Finding: ${text(last?.content)}${heard.length ? ` (heard: ${heard.join(" | ")})` : ""}`)]);
    }
    if (last?.role === "toolResult") return fauxAssistantMessage([fauxText(`Parent answer. ${text(last.content)}`)]);
    return fauxAssistantMessage([fauxToolCall("run_python", {})], { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 200 }, () => respond));
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
    instructions: "You are a document reviewer.",
    tools: ["read_document"],
    task: CHILD_TASK,
    maxRounds: 4,
    maxOutputTokens: 10_000,
    timeoutMs: 30_000,
    runTools: async (calls) => calls.map((call) => ({ tool_use_id: call.id, content: "Clause 12: governed by Delaware law." })),
    ...overrides,
  };
}

function host(overrides: Partial<SubagentSpec> = {}, background: SubagentHost["background"] | null = { timeoutMs: 30_000 }) {
  return {
    toolDescription: "Delegate (test).",
    ...(background ? { background } : {}),
    prepare: vi.fn(async (input: Record<string, unknown>) => spec({ task: String(input.task), ...overrides })),
    started: vi.fn(),
    finished: vi.fn(),
  } satisfies SubagentHost;
}

let turns = 0;
/** One parent turn whose code is `code`; resolves with what the parent answered. */
async function parentTurn(code: (call: NormalizedToolCall) => Promise<string>, subagents: SubagentHost) {
  const n = ++turns;
  const result = await streamChatWithToolsOnPi({
    conversationId: "chat-1",
    model: MODEL,
    systemPrompt: "You are the assistant.",
    messages: [{ role: "user", content: `Turn ${n}` }],
    tools: [runCode, readDocument],
    turn: { userMessageId: `u${n}`, parentMessageId: n > 1 ? `a${n - 1}` : null, assistantMessageId: `a${n}` },
    durableTurn: { context: { surface: "chat", turn: n } },
    subagents,
    runTools: async (calls) => Promise.all(calls.map(async (call) => ({ tool_use_id: call.id, content: await code(call) }))),
  });
  return result.fullText;
}

const startBackground = (call: NormalizedToolCall) =>
  call.delegate!({ type: "document_review", task: `${CHILD_TASK} in the NDA`, background: true }).then((reply) => reply.content);

/** Wait until `check` holds, or fail. */
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let current: ReturnType<typeof setup>;
let woken: string[];
beforeEach(async () => {
  current = setup();
  turns = 0;
  woken = [];
  await resetPiRuntime(current);
  setAgentMessageSink((chatKey) => woken.push(chatKey));
});
afterEach(async () => {
  setAgentMessageSink(undefined);
  await resetPiRuntime();
});

describe("background subagents", () => {
  it("start, outlive the turn, and report into the chat", async () => {
    const delegation = host();
    const answer = await parentTurn(startBackground, delegation);
    expect(answer).toContain("Started document_review-1");

    await until(() => woken.length > 0, "the report");
    expect(woken).toEqual(["chat-1"]);
    expect(await chatsWithAgentMessagesOnPi()).toEqual(["chat-1"]);
    const messages = await takeAgentMessagesOnPi("chat-1");
    expect(messages).toEqual([
      expect.objectContaining({
        from: "document_review-1",
        kind: "report",
        status: "done",
        body: expect.stringContaining("Delaware"),
        wakeContext: { surface: "chat", turn: 1 },
      }),
    ]);
    // Taken once.
    expect(await takeAgentMessagesOnPi("chat-1")).toEqual([]);
    expect(await chatsWithAgentMessagesOnPi()).toEqual([]);

    expect(delegation.started).toHaveBeenCalledWith(expect.objectContaining({ name: "document_review-1" }));
    const transcript = await subagentTranscriptOnPi(messages[0].childId);
    expect(transcript).toMatchObject({ background: true, name: "document_review-1", status: "done" });
  });

  it(`lets a chat have at most ${MAX_WORKING_AGENTS_PER_CHAT} working at once, and ends a refused one's kernel`, async () => {
    const cleanup = vi.fn();
    const delegation = host({ runTools: () => new Promise(() => undefined), cleanup });
    const answer = await parentTurn(async (call) => {
      const replies: string[] = [];
      for (let i = 0; i <= MAX_WORKING_AGENTS_PER_CHAT; i++) replies.push(await startBackground(call));
      return replies.join("\n");
    }, delegation);
    expect(answer.match(/Started document_review-\d/g)).toHaveLength(MAX_WORKING_AGENTS_PER_CHAT);
    expect(answer).toContain("the most this chat may have at once");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("refuses background work when the person has not turned it on", async () => {
    const answer = await parentTurn(startBackground, host({}, null));
    expect(answer).toContain("not turned on");
    expect(childRequests).toHaveLength(0);
  });

  it("takes a message after its work and reports again", async () => {
    const delegation = host();
    await parentTurn(startBackground, delegation);
    await until(() => woken.length === 1, "the first report");
    await takeAgentMessagesOnPi("chat-1");

    const sent = await parentTurn(
      (call) => call.agents!.send({ to: "document_review-1", message: "Which clause?" }).then((reply) => reply.content),
      delegation,
    );
    expect(sent).toContain("Sent to document_review-1");
    await until(() => woken.length === 2, "the second report");
    const [report] = await takeAgentMessagesOnPi("chat-1");
    expect(report).toMatchObject({ kind: "report", status: "done", body: expect.stringContaining("Which clause?") });

    const transcript = await subagentTranscriptOnPi(report.childId);
    expect(transcript!.entries.map((entry) => entry.kind)).toEqual(["task", "assistant", "tool_result", "assistant", "message", "assistant"]);
    expect(transcript!.envelopes.map((envelope) => [envelope.kind, envelope.from, envelope.to])).toEqual([
      ["task", "parent", "document_review-1"],
      ["report", "document_review-1", "parent"],
      ["message", "parent", "document_review-1"],
      ["report", "document_review-1", "parent"],
    ]);
  });

  it("reads a message sent mid-work before its next step, and reports once", async () => {
    let release!: () => void;
    const reading = new Promise<void>((resolve) => (release = resolve));
    const delegation = host({
      runTools: async (calls) => {
        await reading;
        return calls.map((call) => ({ tool_use_id: call.id, content: "Clause 12: governed by Delaware law." }));
      },
    });
    await parentTurn(startBackground, delegation);
    await until(() => childRequests.length === 1, "the child's first step");
    const sent = await parentTurn(
      (call) => call.agents!.send({ to: "document_review-1", message: "Also check clause 14." }).then((reply) => reply.content),
      delegation,
    );
    expect(sent).toContain("It is working");
    release();
    await until(() => woken.length > 0, "the report");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const messages = await takeAgentMessagesOnPi("chat-1");
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toContain("Also check clause 14.");
  });

  it("lets a turn wait in its inbox for a report", async () => {
    const delegation = host();
    const answer = await parentTurn(async (call) => {
      await startBackground(call);
      const inbox = await call.agents!.inbox!({ wait_seconds: 5 });
      return inbox.content;
    }, delegation);
    expect(answer).toContain("Delaware");
    expect(answer).toContain('"from":"document_review-1"');
    // Taken by the turn: nothing is left to wake the chat with.
    expect(await takeAgentMessagesOnPi("chat-1")).toEqual([]);
  });

  it("lists the chat's subagents, and lets one message the chat", async () => {
    let child!: NormalizedToolCall;
    const delegation = host({
      runTools: async (calls) => {
        child = calls[0];
        return calls.map((call) => ({ tool_use_id: call.id, content: "Clause 12: governed by Delaware law." }));
      },
    });
    await parentTurn(startBackground, delegation);
    await until(() => woken.length > 0, "the report");
    const listed = JSON.parse((await child.agents!.list()).content);
    expect(listed.agents).toEqual([expect.objectContaining({ name: "document_review-1", status: "done", can_message: true })]);
    expect(child.agents!.inbox).toBeUndefined();
    expect((await child.agents!.send({ to: "parent", message: "Found it early." })).content).toContain("Sent to the chat");
    const messages = await takeAgentMessagesOnPi("chat-1");
    expect(messages.map((message) => message.kind)).toEqual(["report", "message"]);
    expect(messages[1]).toMatchObject({ from: "document_review-1", body: "Found it early." });
  });

  it("stops one on request without waking the chat", async () => {
    const delegation = host({ runTools: () => new Promise(() => undefined) });
    await parentTurn(startBackground, delegation);
    await until(() => childRequests.length === 1, "the child's first step");
    const stopped = await parentTurn((call) => call.agents!.stop!({ name: "document_review-1" }).then((reply) => reply.content), delegation);
    expect(stopped).toContain("Stopped document_review-1");
    await until(() => delegation.finished.mock.calls.length > 0, "the stop to settle");
    expect(delegation.finished).toHaveBeenCalledWith(expect.objectContaining({ status: "stopped" }));
    expect(woken).toEqual([]);
    expect(await takeAgentMessagesOnPi("chat-1")).toEqual([]);
  });

  it("reports one cut off by a restart to its chat", async () => {
    const delegation = host({ runTools: () => new Promise(() => undefined) });
    await parentTurn(startBackground, delegation);
    await until(() => childRequests.length === 1, "the child's first step");
    await resetPiRuntime(current); // same storage, new process

    expect(await chatsWithAgentMessagesOnPi()).toEqual(["chat-1"]);
    const [report] = await takeAgentMessagesOnPi("chat-1");
    expect(report).toMatchObject({ kind: "report", status: "failed", body: expect.stringContaining("server restart") });
    // It cannot be messaged in the new process.
    const sent = await parentTurn(
      (call) => call.agents!.send({ to: "document_review-1", message: "Still there?" }).then((reply) => reply.content),
      host(),
    );
    expect(sent).toContain("has ended");
  });
});
