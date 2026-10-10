/**
 * `/nr`: a message added to the thread without asking for a reply. It shows
 * at once, is stored with its own call (no stream, no model), and a new chat
 * is created first. When it cannot be stored, the words stay on screen with
 * the reason instead of vanishing.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChat, MikeApiError, postChatNote, streamChat } from "@/app/lib/mikeApi";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
const history = vi.hoisted(() => ({
    replaceChatId: vi.fn(),
    loadChats: vi.fn().mockResolvedValue(undefined),
    setCurrentChatId: vi.fn(),
    saveChat: vi.fn(),
    setNewChatMessages: vi.fn(),
    updateChatTitle: vi.fn(),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => history,
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    createChat: vi.fn(),
    postChatNote: vi.fn(),
    streamChat: vi.fn(),
}));

import { useAssistantChat } from "./useAssistantChat";

afterEach(() => vi.clearAllMocks());

const note = (content: string) => ({ role: "user" as const, content, noResponse: true });

describe("/nr notes", () => {
    it("stores the note in the open chat without streaming a reply", async () => {
        vi.mocked(postChatNote).mockResolvedValue({ id: "m9", parent_message_id: "m8" });
        const { result } = renderHook(() =>
            useAssistantChat({ chatId: "c1", initialMessages: [{ id: "m8", role: "assistant", content: "Done." }] }),
        );

        await act(async () => {
            expect(await result.current.handleChat(note("Client wants it Friday"))).toBe("c1");
        });

        expect(postChatNote).toHaveBeenCalledWith("c1", "Client wants it Friday", undefined);
        expect(streamChat).not.toHaveBeenCalled();
        expect(result.current.messages).toEqual([
            { id: "m8", role: "assistant", content: "Done." },
            { id: "m9", role: "user", content: "Client wants it Friday", noResponse: true, error: undefined },
        ]);
        expect(result.current.isResponseLoading).toBe(false);
    });

    it("stores the note's attachments with it", async () => {
        vi.mocked(postChatNote).mockResolvedValue({ id: "m2", parent_message_id: null });
        const files = [{ filename: "lease.pdf", document_id: "d1" }];
        const { result } = renderHook(() => useAssistantChat({ chatId: "c1" }));

        await act(async () => {
            await result.current.handleChat({ ...note("The signed lease"), files });
        });

        expect(postChatNote).toHaveBeenCalledWith("c1", "The signed lease", files);
        expect(result.current.messages[0]).toMatchObject({ id: "m2", files });
    });

    it("creates the chat first when the note is its first message", async () => {
        vi.mocked(createChat).mockResolvedValue({ id: "new-chat" });
        vi.mocked(postChatNote).mockResolvedValue({ id: "m1", parent_message_id: null });
        const onChatCreated = vi.fn();
        const { result } = renderHook(() => useAssistantChat({ projectId: "p1", onChatCreated }));

        await act(async () => {
            await result.current.handleChat(note("Kickoff notes"));
        });

        expect(createChat).toHaveBeenCalledWith({ project_id: "p1" });
        expect(postChatNote).toHaveBeenCalledWith("new-chat", "Kickoff notes", undefined);
        expect(onChatCreated).toHaveBeenCalledWith("new-chat");
        expect(result.current.messages.map((m) => m.id)).toEqual(["m1"]);
    });

    it("keeps a note that could not be stored on screen, with the reason", async () => {
        vi.mocked(postChatNote).mockRejectedValue(
            new MikeApiError({
                message: "A response is still being generated in this chat. Try again once it finishes.",
                status: 409,
                code: "turn_in_progress",
            }),
        );
        const { result } = renderHook(() => useAssistantChat({ chatId: "c1" }));

        await act(async () => {
            expect(await result.current.handleChat(note("Late thought"))).toBeNull();
        });

        await waitFor(() =>
            expect(result.current.messages).toEqual([
                {
                    role: "user",
                    content: "Late thought",
                    noResponse: true,
                    error: "Not added. A response is still being generated in this chat. Try again once it finishes.",
                },
            ]),
        );
    });
});
