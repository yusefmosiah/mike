import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const { abandonTurn, finishTurn, prepareTabularChat, runLLMStream } =
    vi.hoisted(() => ({
        abandonTurn: vi.fn(async () => undefined),
        finishTurn: vi.fn(async () => undefined),
        prepareTabularChat: vi.fn(),
        runLLMStream: vi.fn(),
    }));

vi.mock("../../../lib/llm", () => ({ abandonTurn, finishTurn }));
vi.mock("../../../lib/memory/schedule", () => ({
    releaseMemoryConversationTurn: vi.fn(),
    scheduleMemoryConsolidation: vi.fn(async () => null),
}));
vi.mock("../tabular.chats", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../tabular.chats")>()),
    prepareTabularChat,
}));
vi.mock("../../chat/chat.service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../chat/chat.service")>()),
    runLLMStream,
}));

import { getAssistantTurnRun } from "../../../lib/assistantTurnRuns";
import {
    driveTabularChatTurn,
    resumeInterruptedTabularChatTurn,
    type TabularChatTurnResumeContext,
} from "../tabular.turn";

const CONTEXT: TabularChatTurnResumeContext = {
    surface: "tabular",
    userId: "user-1",
    userEmail: "me@example.com",
    reviewId: "rev-1",
    chatId: "chat-1",
    model: null,
    reasoning: null,
    timeZone: null,
    reviewTitle: "Leases",
    projectName: null,
    turnUserMessageId: "prompt-1",
};

const ROWS = [
    { id: "prompt-0", role: "user", content: "first" },
    { id: "answer-0", role: "assistant", content: [{ type: "content", text: "ok" }] },
    { id: "prompt-1", role: "user", content: "second" },
];

const PREPARED = {
    reviewTitle: "Leases",
    tabularStore: { columns: [], documents: [], cells: new Map() },
    chatId: "chat-1",
    chatTitle: "Leases chat",
    isFirstExchange: false,
    model: "claude-sonnet-5",
    reasoningLevel: null,
    titleModel: "claude-haiku-5",
    apiKeys: {},
    apiMessages: [],
    inputMessageId: "prompt-1",
    turnParentMessageId: "answer-0",
    readableMemoryProjectId: null,
    writableMemoryProjectId: null,
    memorySharedAudience: false,
    memoryTurn: null,
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe("resumeInterruptedTabularChatTurn", () => {
    it("drives the turn again from storage and stores its answer", async () => {
        prepareTabularChat.mockResolvedValue({ ok: true, data: PREPARED });
        runLLMStream.mockResolvedValue({
            fullText: "done",
            events: [{ type: "content", text: "done" }],
        });
        const script = scriptedDb([
            { table: "tabular_review_chat_messages", data: ROWS },
            // The resumed turn claims its review chat again under its own id.
            { rpc: "claim_chat_turn", data: [{ granted: true }] },
            { table: "tabular_review_chat_messages", op: "insert" },
            { table: "tabular_review_chats", op: "update" },
            { rpc: "release_chat_turn" },
        ]);

        await resumeInterruptedTabularChatTurn(script.db, {
            assistantMessageId: "answer-1",
            context: CONTEXT,
        });

        script.done();
        expect(prepareTabularChat).toHaveBeenCalledWith(
            script.db,
            expect.objectContaining({
                reviewId: "rev-1",
                chatId: "chat-1",
                lastUserContent: "second",
                resumeUserMessageId: "prompt-1",
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
        expect(script.calls[2].payload).toMatchObject({
            id: "answer-1",
            chat_id: "chat-1",
            role: "assistant",
            memory_input_message_id: "prompt-1",
        });
        expect(finishTurn).toHaveBeenCalledWith("answer-1");
        expect(abandonTurn).not.toHaveBeenCalled();
        expect(getAssistantTurnRun("answer-1", "tabular")?.finished).toBe(true);
        expect(script.calls.find((call) => call.table === "claim_chat_turn")?.args).toMatchObject({
            p_surface: "tabular",
            p_chat_id: "chat-1",
            p_turn_id: "answer-1",
        });
    });

    it("gives up a turn whose answer was stored before the process died", async () => {
        const script = scriptedDb([
            {
                table: "tabular_review_chat_messages",
                data: [...ROWS, { id: "answer-1", role: "assistant", content: [] }],
            },
        ]);
        await resumeInterruptedTabularChatTurn(script.db, {
            assistantMessageId: "answer-1",
            context: CONTEXT,
        });
        script.done();
        expect(abandonTurn).toHaveBeenCalledWith("answer-1");
        expect(prepareTabularChat).not.toHaveBeenCalled();
    });

    it("stores an error answer when the review can no longer be reached", async () => {
        prepareTabularChat.mockResolvedValue({
            ok: false,
            kind: "not_found",
            detail: "Review not found",
        });
        const script = scriptedDb([
            { table: "tabular_review_chat_messages", data: ROWS },
            { table: "tabular_review_chat_messages", data: ROWS },
            { table: "tabular_review_chat_messages", op: "insert" },
        ]);
        await resumeInterruptedTabularChatTurn(script.db, {
            assistantMessageId: "answer-1",
            context: CONTEXT,
        });
        script.done();
        expect(abandonTurn).toHaveBeenCalledWith("answer-1");
        expect(script.calls[2].payload).toMatchObject({
            id: "answer-1",
            role: "assistant",
            content: [expect.objectContaining({ type: "error" })],
        });
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("stores nothing when the prompt itself is gone", async () => {
        const rows = ROWS.slice(0, 2);
        const script = scriptedDb([
            { table: "tabular_review_chat_messages", data: rows },
            { table: "tabular_review_chat_messages", data: rows },
        ]);
        await resumeInterruptedTabularChatTurn(script.db, {
            assistantMessageId: "answer-1",
            context: CONTEXT,
        });
        script.done();
        expect(abandonTurn).toHaveBeenCalledWith("answer-1");
        expect(prepareTabularChat).not.toHaveBeenCalled();
    });
});

describe("driveTabularChatTurn", () => {
    it("refuses a second turn while a colleague's turn holds the review chat", async () => {
        const script = scriptedDb([
            {
                rpc: "claim_chat_turn",
                data: [{ granted: false, holder_turn_id: "their-turn", holder_actor_user_id: "colleague", holder_actor_role: null, holder_claimed_at: "2026-10-10T10:00:00Z" }],
            },
        ]);
        const open = vi.fn();
        const outcome = await driveTabularChatTurn(script.db, {
            prepared: PREPARED as never,
            userId: "user-1",
            lastUserContent: "second",
            clientReviewTitle: null,
            clientProjectName: null,
            assistantMessageId: "my-turn",
            durableContext: null,
            open,
        });
        script.done();
        expect(outcome).toEqual({
            ok: false,
            status: 409,
            body: {
                code: "turn_in_progress",
                detail: "A response is already being generated for this chat.",
                generating: { user_id: "colleague", since: "2026-10-10T10:00:00Z" },
            },
        });
        expect(open).not.toHaveBeenCalled();
        expect(runLLMStream).not.toHaveBeenCalled();
    });
});
