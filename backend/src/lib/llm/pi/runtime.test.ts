import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createMikeModels } from "./providers.mjs";
import {
  abandonTurnOnPi,
  completeTextOnPi,
  forkChatLineageOnPi,
  interruptedTurnsOnPi,
  finishTurnOnPi,
  piRuntime,
  resetPiRuntime,
  streamChatWithToolsOnPi,
} from "./runtime.mjs";
import type { LlmMessage, OpenAIToolSchema, StreamChatParams } from "../types";

const MODEL = "opencode-go/test-model";
const readDocument: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "read_document",
    description: "Read a document",
    parameters: { type: "object", properties: { doc_id: { type: "string" } }, required: ["doc_id"] },
  },
};

const editDocument: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "edit_document",
    description: "Edit a document",
    parameters: { type: "object", properties: { doc_id: { type: "string" } }, required: ["doc_id"] },
  },
};

type Seen = { users: string[]; toolResults: string[]; text: string };
let requests: Seen[];

/** The scripted model: answers with what it was shown, and reads a document when asked to. */
function setup(options: { tokensPerSecond?: number } = {}) {
  requests = [];
  const faux = fauxProvider({
    provider: "opencode-go",
    models: [{ id: "test-model", input: ["text"] }],
    ...(options.tokensPerSecond ? { tokensPerSecond: options.tokensPerSecond, tokenSize: { min: 4, max: 4 } } : {}),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const respond = (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
    const text = (content: unknown) =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part: { type: string; text?: string }) => part.text ?? "").join("")
          : "";
    const seen: Seen = {
      users: ctx.messages.filter((m) => m.role === "user").map((m) => text(m.content)),
      toolResults: ctx.messages.filter((m) => m.role === "toolResult").map((m) => text(m.content)),
      text: "",
    };
    requests.push(seen);
    const last = ctx.messages.at(-1);
    const firstUser = text(ctx.messages.find((m) => m.role === "user")?.content);
    if (firstUser.includes("keep reading") && !(last?.role === "toolResult" && text(last.content).startsWith("Not run"))) {
      return fauxAssistantMessage([fauxToolCall("read_document", { doc_id: `nda-${requests.length}` })], { stopReason: "toolUse" });
    }
    if (last?.role === "user" && text(last.content).includes("edit NDA")) {
      return fauxAssistantMessage([fauxToolCall("edit_document", { doc_id: "nda" })], { stopReason: "toolUse" });
    }
    if (last?.role === "user" && text(last.content).includes("read NDA")) {
      return fauxAssistantMessage([fauxToolCall("read_document", { doc_id: "nda" })], { stopReason: "toolUse" });
    }
    if (firstUser.includes("long list")) {
      return fauxAssistantMessage([fauxText(`attempt ${requests.length}: ${"clause. ".repeat(40)}`)]);
    }
    return fauxAssistantMessage([fauxText(`answer ${requests.length}`)]);
  };
  faux.setResponses(Array.from({ length: 50 }, () => respond));
  // A restart is a new Harness over the same data: the storage outlives the
  // Harness that closes it, as a database outlives its process.
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

async function turn(
  messages: LlmMessage[],
  identity: { user: string; parent: string | null; assistant: string },
  extra: Partial<StreamChatParams> = {},
) {
  return streamChatWithToolsOnPi({
    conversationId: "chat-1",
    model: MODEL,
    systemPrompt: "You are Mike.",
    messages,
    tools: [readDocument],
    turn: { userMessageId: identity.user, parentMessageId: identity.parent, assistantMessageId: identity.assistant },
    runTools: async (calls) => calls.map((call) => ({ tool_use_id: call.id, content: "NDA says: governing law is Delaware." })),
    ...extra,
  });
}

async function lineage(chat = "chat-1") {
  const { harness } = await piRuntime();
  const { defineDocFamily } = await import("@earendil-works/pi-durable");
  const token = defineDocFamily<{ conversations: number[]; messages: Record<string, { conversation: number; entry: number }> }, null>({
    kind: "mike.chat",
    version: 2,
    scope: "session",
    family: true,
    initial: () => ({ conversations: [], messages: {} }),
  });
  return (await harness.snapshot(token, chat, context))!;
}

let current: ReturnType<typeof setup>;
beforeEach(async () => {
  current = setup();
  await resetPiRuntime(current);
});
afterEach(async () => {
  await resetPiRuntime();
});

describe("Pi runtime: turns, branches and memory", () => {
  it("continues the parent's conversation, and later turns see earlier tool results", async () => {
    const q1 = "Please read NDA";
    const a1 = await turn([{ role: "user", content: q1 }], { user: "u1", parent: null, assistant: "a1" });
    await turn(
      [{ role: "user", content: q1 }, { role: "assistant", content: a1.fullText }, { role: "user", content: "governing law?" }],
      { user: "u2", parent: "a1", assistant: "a2" },
    );
    const map = await lineage();
    expect(map.conversations).toHaveLength(1);
    expect(map.messages.a1.conversation).toBe(map.messages.a2.conversation);
    // The second turn's request carried the first turn's tool result.
    expect(requests.at(-1)!.toolResults.join("")).toContain("Delaware");
  });

  it("regenerating forks at the parent answer, and identical prompt text stays two branches", async () => {
    const q1 = "first question";
    const q2 = "same words";
    const a1 = await turn([{ role: "user", content: q1 }], { user: "u1", parent: null, assistant: "a1" });
    const history = [{ role: "user" as const, content: q1 }, { role: "assistant" as const, content: a1.fullText }, { role: "user" as const, content: q2 }];
    await turn(history, { user: "u2", parent: "a1", assistant: "a2" });
    // A second prompt version with the SAME text, parented to a1: a fork, not a continuation.
    await turn(history, { user: "u2b", parent: "a1", assistant: "a2b" });
    let map = await lineage();
    expect(map.conversations).toHaveLength(2);
    expect(map.messages.a2b.conversation).not.toBe(map.messages.a2.conversation);

    // Following up on the ORIGINAL version continues its own conversation.
    await turn([...history, { role: "assistant", content: "x" }, { role: "user", content: "follow up" }], {
      user: "u3",
      parent: "a2",
      assistant: "a3",
    });
    map = await lineage();
    expect(map.messages.a3.conversation).toBe(map.messages.a2.conversation);
    expect(map.conversations).toHaveLength(2);
    // That request saw the original branch only: one copy of the repeated prompt.
    expect(requests.at(-1)!.users.filter((u) => u.includes(q2))).toHaveLength(1);
  });

  it("editing the first message starts a new root conversation", async () => {
    await turn([{ role: "user", content: "original" }], { user: "u1", parent: null, assistant: "a1" });
    await turn([{ role: "user", content: "edited" }], { user: "u1b", parent: null, assistant: "a1b" });
    const map = await lineage();
    expect(map.messages.a1b.conversation).not.toBe(map.messages.a1.conversation);
    expect(requests.at(-1)!.users.join("|")).not.toContain("original");
  });

  it("snapshots memory into the thread's first message once and never re-sends it", async () => {
    const memory = { role: "user" as const, content: "MEMORY v1: prefers short answers" };
    const a1 = await turn([memory, { role: "user", content: "hello" }], { user: "u1", parent: null, assistant: "a1" }, { memoryMessage: memory });
    const memory2 = { role: "user" as const, content: "MEMORY v2: changed by the curator" };
    await turn(
      [memory2, { role: "user", content: "hello" }, { role: "assistant", content: a1.fullText }, { role: "user", content: "again" }],
      { user: "u2", parent: "a1", assistant: "a2" },
      { memoryMessage: memory2 },
    );
    const second = requests.at(-1)!.users.join("\n");
    expect(second).toContain("MEMORY v1");
    expect(second).not.toContain("MEMORY v2");
    expect(second.match(/<thread-memory>/g)).toHaveLength(1);
  });

  it("branching into a new chat forks the transcript at the answer, leaving the source chat's own", async () => {
    const { harness } = await piRuntime();
    const a1 = await turn([{ role: "user", content: "first question" }], { user: "u1", parent: null, assistant: "a1" });
    const h2 = [{ role: "user" as const, content: "first question" }, { role: "assistant" as const, content: a1.fullText }, { role: "user" as const, content: "second question" }];
    await turn(h2, { user: "u2", parent: "a1", assistant: "a2" });
    const source = await lineage();
    const sourceConversation = source.messages.a2.conversation;
    const sourceEntries = async () =>
      (await (await harness.conversation(sourceConversation as never, context))!.entries({ order: "ascending" }, 500, undefined, context)).items.length;
    const before = await sourceEntries();

    // Fork at a2 into chat-2 (copies u1', a1', u2', a2').
    await forkChatLineageOnPi({
      fromChatId: "chat-1",
      toChatId: "chat-2",
      atMessageId: "a2",
      messageIds: { u1: "u1c", a1: "a1c", u2: "u2c", a2: "a2c" },
    });
    const fork = await lineage("chat-2");
    expect(fork.conversations).toHaveLength(1);
    expect(fork.messages.a2c.conversation).toBe(fork.conversations[0]);

    // The new chat's first turn continues the fork, with the whole copied history.
    await turn([...h2, { role: "assistant", content: "x" }, { role: "user", content: "third, in the new chat" }], { user: "u3c", parent: "a2c", assistant: "a3c" }, { conversationId: "chat-2" });
    expect(requests.at(-1)!.users.join("|")).toContain("second question");
    expect((await lineage("chat-2")).messages.a3c.conversation).toBe(fork.conversations[0]);

    // Editing the copied second prompt forks from the source's place, never appending to it.
    await turn([...h2.slice(0, 2), { role: "user", content: "second, edited in the new chat" }], { user: "u2c2", parent: "a1c", assistant: "a2c2" }, { conversationId: "chat-2" });
    const after = await lineage("chat-2");
    expect(after.conversations).toHaveLength(2);
    expect(after.messages.a2c2.conversation).not.toBe(sourceConversation);
    expect(requests.at(-1)!.users.join("|")).not.toContain("second question");
    expect(await sourceEntries()).toBe(before);
  });

  it("falls back to matching history the runtime never stored", async () => {
    // A chat begun before this runtime: the parent id was never mapped.
    await turn(
      [{ role: "user", content: "old question" }, { role: "assistant", content: "old answer" }, { role: "user", content: "new question" }],
      { user: "u2", parent: "legacy-a1", assistant: "a2" },
    );
    expect(requests.at(-1)!.users.join("|")).toContain("old question");
    const map = await lineage();
    expect(map.messages.a2).toBeDefined();
  });

  it("stops running tools once the turn's round budget is spent, and the model still answers", async () => {
    let runs = 0;
    const result = await turn([{ role: "user", content: "keep reading documents" }], { user: "u1", parent: null, assistant: "a1" }, {
      maxIterations: 2,
      runTools: async (calls) => calls.map((call) => (runs++, { tool_use_id: call.id, content: "more text" })),
    });
    expect(runs).toBe(2);
    expect(result.fullText).toMatch(/^answer/);
  });

  it("runs a one-shot loop without a chat in memory, leaving nothing in durable storage", async () => {
    const { harness } = await piRuntime();
    const result = await streamChatWithToolsOnPi({
      model: MODEL,
      systemPrompt: "Curate memory.",
      messages: [{ role: "user", content: "Please read NDA" }],
      tools: [readDocument],
      runTools: async (calls) => calls.map((call) => ({ tool_use_id: call.id, content: "Delaware" })),
    });
    expect(result.fullText).toMatch(/^answer/);
    expect(requests.at(-1)!.toolResults.join("")).toContain("Delaware");
    // The durable Harness never saw it: its first conversation id is still unused.
    expect(await harness.conversation(1 as never, context)).toBeUndefined();
  });

  it("gives a text-only model a rendered page's own text, not an omitted-image placeholder", async () => {
    await turn(
      [{ role: "user", content: [{ type: "text", text: "Summarise:" }, { type: "image", image: new Uint8Array([1, 2, 3]), mimeType: "image/png", fallbackText: "PAGE 1: governing law is Delaware" }] }],
      { user: "u1", parent: null, assistant: "a1" },
    );
    expect(requests.at(-1)!.users.join("")).toContain("PAGE 1: governing law is Delaware");
  });

  it("answers a one-shot prompt without tools or a transcript", async () => {
    const text = await completeTextOnPi({ model: MODEL, systemPrompt: "Title this.", user: "An NDA question" });
    expect(text).toMatch(/^answer/);
    expect(requests.at(-1)!.users).toEqual(["An NDA question"]);
  });

  it("a turn cut off by a restart is driven again: the read reruns, the input is not sent twice", async () => {
    const durableTurn = { context: { surface: "chat", note: "how to drive me again" } };
    const identity = { user: "u1", parent: null, assistant: "a1" };
    // Built in code like Mike's own schemas: not strict JSON until stored.
    const tools = [{ ...readDocument, function: { ...readDocument.function, strict: undefined } }] as OpenAIToolSchema[];
    // The process dies while the tool runs: the request never settles.
    void turn([{ role: "user", content: "Please read NDA" }], identity, {
      durableTurn,
      tools,
      runTools: () => new Promise(() => undefined),
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await resetPiRuntime(current); // same storage, new process

    const interrupted = await interruptedTurnsOnPi();
    expect(interrupted).toEqual([expect.objectContaining({ assistantMessageId: "a1", context: durableTurn.context })]);

    const shown: string[] = [];
    const resumed = await turn([{ role: "user", content: "Please read NDA" }], identity, {
      durableTurn: { ...durableTurn, resume: true },
      callbacks: { onToolCallStart: (call) => shown.push(`tool:${call.name}`), onContentDelta: (d) => shown.push(d) },
    });
    expect(resumed.fullText).toMatch(/^answer/);
    // The read ran again through the new request, and its result reached the model.
    expect(requests.at(-1)!.toolResults.join("")).toContain("Delaware");
    expect(requests.at(-1)!.users.filter((u) => u.includes("Please read NDA"))).toHaveLength(1);
    // The caller saw the tool the turn had already started, then the answer.
    expect(shown[0]).toBe("tool:read_document");
    expect(shown.join("")).toContain("answer");
    expect((await lineage()).messages.a1).toBeDefined();
    // Answered, but resumable until the caller has stored it.
    expect(await interruptedTurnsOnPi()).toHaveLength(1);
    await finishTurnOnPi("a1");
    expect(await interruptedTurnsOnPi()).toEqual([]);
  });

  it("an answer finished but not yet stored when the process died is returned again, not regenerated", async () => {
    const durableTurn = { context: { surface: "chat" } };
    const identity = { user: "u1", parent: null, assistant: "a1" };
    const first = await turn([{ role: "user", content: "Please read NDA" }], identity, { durableTurn });
    const sent = requests.length;
    await resetPiRuntime(current); // died before storing the answer

    const shown: string[] = [];
    const again = await turn([{ role: "user", content: "Please read NDA" }], identity, {
      durableTurn: { ...durableTurn, resume: true },
      callbacks: { onContentDelta: (d) => shown.push(d) },
    });
    expect(again.fullText).toBe(first.fullText);
    expect(shown.join("")).toBe(first.fullText);
    expect(requests).toHaveLength(sent);
  });

  it("an answer cut off mid-stream restarts cleanly: the partial before the crash is not shown", async () => {
    current = setup({ tokensPerSecond: 40 });
    await resetPiRuntime(current);
    const durableTurn = { context: { surface: "chat" } };
    const identity = { user: "u1", parent: null, assistant: "a1" };
    let streamed = "";
    void turn([{ role: "user", content: "write a long list" }], identity, {
      durableTurn,
      callbacks: { onContentDelta: (d) => (streamed += d) },
    }).catch(() => undefined);
    await vi.waitFor(() => expect(streamed).toContain("attempt 1"), { timeout: 2000 });
    await resetPiRuntime(current); // died mid-answer

    let shown = "";
    const resumed = await turn([{ role: "user", content: "write a long list" }], identity, {
      durableTurn: { ...durableTurn, resume: true },
      callbacks: { onContentDelta: (d) => (shown += d) },
    });
    expect(resumed.fullText).toMatch(/^attempt 2: /);
    expect(shown).toBe(resumed.fullText);
  }, 15_000);

  it("a write cut off by a restart is not run again: the model is told it was interrupted", async () => {
    const durableTurn = { context: { surface: "chat" } };
    const identity = { user: "u1", parent: null, assistant: "a1" };
    let writes = 0;
    void turn([{ role: "user", content: "Please edit NDA" }], identity, {
      durableTurn,
      tools: [readDocument, editDocument],
      runTools: () => (writes++, new Promise(() => undefined)),
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(writes).toBe(1);
    await resetPiRuntime(current);

    const resumed = await turn([{ role: "user", content: "Please edit NDA" }], identity, {
      durableTurn: { ...durableTurn, resume: true },
      tools: [readDocument, editDocument],
      runTools: async (calls) => calls.map((call) => (writes++, { tool_use_id: call.id, content: "edited" })),
    });
    expect(writes).toBe(1);
    expect(resumed.fullText).toMatch(/^answer/);
    expect(requests.at(-1)!.toolResults.join("")).not.toContain("edited");
    expect(requests.at(-1)!.toolResults.join("")).toMatch(/interrupt/i);
  });

  it("a turn nobody can resume is stopped after a restart, not run on for no one", async () => {
    // A Word or tabular turn: bound to a chat, but not recorded as durable.
    void turn([{ role: "user", content: "Please read NDA" }], { user: "u1", parent: null, assistant: "a1" }, {
      runTools: () => new Promise(() => undefined),
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sent = requests.length;
    await resetPiRuntime(current);
    const { harness } = await piRuntime();
    await vi.waitFor(async () => expect((await harness.inspect(context)).tasks).toHaveLength(0), { timeout: 2000 });
    expect(requests).toHaveLength(sent);
  });

  it("an interrupted turn can be given up, which stops its run", async () => {
    void turn([{ role: "user", content: "Please read NDA" }], { user: "u1", parent: null, assistant: "a1" }, {
      durableTurn: { context: {} },
      runTools: () => new Promise(() => undefined),
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await resetPiRuntime(current);
    await abandonTurnOnPi("a1");
    expect(await interruptedTurnsOnPi()).toEqual([]);
    await expect(
      turn([{ role: "user", content: "Please read NDA" }], { user: "u1", parent: null, assistant: "a1" }, {
        durableTurn: { context: {}, resume: true },
      }),
    ).rejects.toThrow("no longer in progress");
  });

  it("a tool that ends the turn (an ask_inputs pause) stops it: no further model request, the error reaches the caller", async () => {
    class Pause extends Error {}
    const sent = requests.length;
    await expect(
      turn([{ role: "user", content: "Please read NDA" }], { user: "u1", parent: null, assistant: "a1" }, {
        runTools: async () => {
          throw new Pause("waiting for the user's answer");
        },
      }),
    ).rejects.toBeInstanceOf(Pause);
    // Only the request that asked for the tool; nothing after the pause.
    expect(requests.length - sent).toBe(1);
  });

  it("stopping a turn stops a tool that is still running and leaves no tool task behind", async () => {
    const { harness } = await piRuntime();
    // A turn whose tool never returns, stopped from the request.
    const abort = new AbortController();
    const pending = turn([{ role: "user", content: "Please read NDA" }], { user: "u1", parent: null, assistant: "a1" }, {
      abortSignal: abort.signal,
      runTools: () => new Promise(() => undefined),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect((await harness.inspect(context)).tasks.filter((task) => task.record.kind === "pi.tool")).toHaveLength(0);
  });
});
