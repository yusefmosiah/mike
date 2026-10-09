import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { piRuntime, resetPiRuntime, streamChatWithToolsOnPi } from "./runtime.mjs";
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

type Seen = { users: string[]; toolResults: string[]; text: string };
let requests: Seen[];

/** The scripted model: answers with what it was shown, and reads a document when asked to. */
function setup() {
  requests = [];
  const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "test-model" }] });
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
    if (last?.role === "user" && text(last.content).includes("read NDA")) {
      return fauxAssistantMessage([fauxToolCall("read_document", { doc_id: "nda" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage([fauxText(`answer ${requests.length}`)]);
  };
  faux.setResponses(Array.from({ length: 50 }, () => respond));
  return { models, storage: new MemoryStorage() };
}

async function turn(
  messages: LlmMessage[],
  identity: { user: string; parent: string | null; assistant: string },
  extra: Partial<StreamChatParams> = {},
) {
  return streamChatWithToolsOnPi({
    model: MODEL,
    systemPrompt: "You are Mike.",
    messages,
    tools: [readDocument],
    conversationId: "chat-1",
    turn: { userMessageId: identity.user, parentMessageId: identity.parent, assistantMessageId: identity.assistant },
    runTools: async (calls) => calls.map((call) => ({ tool_use_id: call.id, content: "NDA says: governing law is Delaware." })),
    ...extra,
  });
}

async function lineage() {
  const { harness } = await piRuntime();
  const { defineDocFamily } = await import("@earendil-works/pi-durable");
  const token = defineDocFamily<{ conversations: number[]; messages: Record<string, { conversation: number; entry: number }> }, null>({
    kind: "mike.chat",
    version: 2,
    scope: "session",
    family: true,
    initial: () => ({ conversations: [], messages: {} }),
  });
  return (await harness.snapshot(token, "chat-1", context))!;
}

beforeEach(async () => {
  await resetPiRuntime(setup());
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
