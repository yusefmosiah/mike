import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const { abandonTurn, finishTurn, prepareWordChatStream, runLLMStream } =
  vi.hoisted(() => ({
    abandonTurn: vi.fn(async () => undefined),
    finishTurn: vi.fn(async () => undefined),
    prepareWordChatStream: vi.fn(),
    runLLMStream: vi.fn(),
  }));

vi.mock("../../../lib/llm", () => ({ abandonTurn, finishTurn }));
vi.mock("../../../lib/audit", () => ({ enqueueChatTurnAudit: vi.fn() }));
vi.mock("../../../lib/memory/schedule", () => ({
  releaseMemoryConversationTurn: vi.fn(),
  scheduleMemoryConsolidation: vi.fn(async () => null),
}));
vi.mock("../wordChat.prepare", () => ({
  prepareWordChatStream,
  recordWordChatActivity: vi.fn(async () => null),
}));
vi.mock("../../chat/chat.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../chat/chat.service")>()),
  runLLMStream,
  persistWordDocumentEdits: vi.fn(async ({ events }: { events: unknown[] }) => ({ events })),
}));

import { getAssistantTurnRun } from "../../../lib/assistantTurnRuns";
import {
  resumeInterruptedWordChatTurn,
  type WordChatTurnResumeContext,
} from "../wordChat.turn";

const CONTEXT: WordChatTurnResumeContext = {
  surface: "word",
  userId: "user-1",
  userEmail: "me@example.com",
  chatId: "chat-1",
  clientDocumentId: "11111111-1111-4111-8111-111111111111",
  activeDocumentName: "Lease.docx",
  documentContext: "# Lease",
  clientToolsEnabled: false,
  editApplyMode: "approval",
  model: null,
  reasoning: null,
  timeZone: "Europe/London",
  turnUserMessageId: "prompt-1",
};

const ROWS = [
  { id: "prompt-0", role: "user", content: "first", files: null, workflow: null },
  {
    id: "answer-0",
    role: "assistant",
    content: [{ type: "content", text: "ok" }],
    files: null,
    workflow: null,
  },
  { id: "prompt-1", role: "user", content: "second", files: null, workflow: null },
  { id: "answer-1", role: "assistant", content: null, files: null, workflow: null },
];

const PREPARED = {
  chatId: "chat-1",
  chatTitle: "Lease",
  lastUserContent: "second",
  inputMessageId: "prompt-1",
  turnParentMessageId: "answer-0",
  memoryTurn: null,
  docIndex: {},
  docStore: new Map(),
  apiMessages: [],
  workflowStore: {},
  apiKeys: {},
  selectedModel: "claude-sonnet-5",
  selectedReasoningLevel: null,
  nonce: "nonce",
};

const RESTART_FAILURE = expect.objectContaining({
  content: [expect.objectContaining({ type: "error" })],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resumeInterruptedWordChatTurn", () => {
  it("drives the turn again from storage into a fresh run", async () => {
    prepareWordChatStream.mockResolvedValue({ ok: true, prepared: PREPARED });
    runLLMStream.mockResolvedValue({
      events: [{ type: "content", text: "done" }],
      citations: [],
    });
    const script = scriptedDb([
      { table: "word_chat_messages", data: ROWS },
      // The reserved row gets the answer; nothing is reserved again.
      { table: "word_chat_messages", op: "update" },
    ]);

    await resumeInterruptedWordChatTurn(script.db, {
      assistantMessageId: "answer-1",
      context: CONTEXT,
    });

    script.done();
    expect(prepareWordChatStream).toHaveBeenCalledWith(
      script.db,
      expect.objectContaining({
        chatId: "chat-1",
        persistChat: true,
        documentContext: "# Lease",
        resumeUserMessageId: "prompt-1",
        // The history up to the prompt, without the empty reservation.
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "second" },
        ],
      }),
    );
    expect(runLLMStream).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "chat-1",
        turn: {
          userMessageId: "prompt-1",
          parentMessageId: "answer-0",
          assistantMessageId: "answer-1",
        },
        durableTurn: { context: CONTEXT, resume: true },
      }),
    );
    expect(script.calls[1].payload).toEqual({
      content: [{ type: "content", text: "done" }],
      citations: null,
    });
    expect(finishTurn).toHaveBeenCalledWith("answer-1");
    expect(abandonTurn).not.toHaveBeenCalled();
    // The run is registered for the pane to attach to.
    expect(getAssistantTurnRun("answer-1", "word")?.finished).toBe(true);
  });

  it("gives up a turn whose answer was stored before the process died", async () => {
    const script = scriptedDb([
      {
        table: "word_chat_messages",
        data: ROWS.map((row) =>
          row.id === "answer-1" ? { ...row, content: [{ type: "content", text: "x" }] } : row,
        ),
      },
    ]);
    await resumeInterruptedWordChatTurn(script.db, {
      assistantMessageId: "answer-1",
      context: CONTEXT,
    });
    script.done();
    expect(abandonTurn).toHaveBeenCalledWith("answer-1");
    expect(prepareWordChatStream).not.toHaveBeenCalled();
  });

  it("stores the interruption when a later prompt moved the chat on", async () => {
    const script = scriptedDb([
      {
        table: "word_chat_messages",
        data: [
          ...ROWS,
          { id: "prompt-2", role: "user", content: "third", files: null, workflow: null },
        ],
      },
      { table: "word_chat_messages", op: "update" },
    ]);
    await resumeInterruptedWordChatTurn(script.db, {
      assistantMessageId: "answer-1",
      context: CONTEXT,
    });
    script.done();
    expect(abandonTurn).toHaveBeenCalledWith("answer-1");
    expect(script.calls[1].payload).toEqual(RESTART_FAILURE);
    expect(prepareWordChatStream).not.toHaveBeenCalled();
  });

  it("stores the interruption when the chat can no longer be prepared", async () => {
    prepareWordChatStream.mockResolvedValue({
      ok: false,
      status: 404,
      detail: "Chat not found",
    });
    const script = scriptedDb([
      { table: "word_chat_messages", data: ROWS },
      { table: "word_chat_messages", op: "update" },
    ]);
    await resumeInterruptedWordChatTurn(script.db, {
      assistantMessageId: "answer-1",
      context: CONTEXT,
    });
    script.done();
    expect(abandonTurn).toHaveBeenCalledWith("answer-1");
    expect(script.calls[1].payload).toEqual(RESTART_FAILURE);
    expect(runLLMStream).not.toHaveBeenCalled();
  });

  it("gives up a context it cannot read without touching storage", async () => {
    const script = scriptedDb([]);
    await resumeInterruptedWordChatTurn(script.db, {
      assistantMessageId: "answer-1",
      context: { surface: "word", userId: "user-1" },
    });
    script.done();
    expect(abandonTurn).toHaveBeenCalledWith("answer-1");
  });
});
