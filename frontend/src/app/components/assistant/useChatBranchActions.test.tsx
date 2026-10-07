import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../shared/types";
import { useChatBranchActions } from "./useChatBranchActions";

const api = vi.hoisted(() => ({
    createBranch: vi.fn(),
    setChatLeaf: vi.fn(),
    fetchSiblings: vi.fn(),
    getChat: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return { ...original, ...api };
});

const oldPrompt: Message = {
    id: "prompt-1",
    role: "user",
    content: "original question",
};
const oldAnswer: Message = { id: "answer-1", role: "assistant", content: "old" };

function setup(initialMessages: Message[]) {
    const handleChat = vi.fn().mockResolvedValue(null);
    const setMessages = vi.fn();
    const view = renderHook(
        ({ messages }: { messages: Message[] }) =>
            useChatBranchActions({
                chatId: "chat-1",
                messages,
                setMessages,
                handleChat,
            }),
        { initialProps: { messages: initialMessages } },
    );
    return { ...view, handleChat, setMessages };
}

describe("useChatBranchActions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("saves an edited prompt, reloads, and re-answers it linked", async () => {
        const reloaded: Message[] = [
            oldPrompt,
            { id: "prompt-2", role: "user", content: "edited question" },
        ];
        api.createBranch.mockResolvedValue({
            id: "prompt-2",
            leaf: "prompt-2",
            messages: reloaded,
        });
        api.getChat.mockResolvedValue({ messages: reloaded });
        const view = setup([oldPrompt, oldAnswer]);

        await act(async () => {
            await view.result.current.editPrompt({
                message: oldPrompt,
                content: "edited question",
            });
        });

        expect(api.createBranch).toHaveBeenCalledWith("chat-1", {
            from_message_id: "prompt-1",
            content: "edited question",
            files: undefined,
            workflow: undefined,
        });
        expect(view.setMessages).toHaveBeenCalledWith(reloaded);

        // The re-answer waits for the reloaded path to land…
        expect(view.handleChat).not.toHaveBeenCalled();
        view.rerender({ messages: reloaded });

        // …then streams the new prompt linked to its stored row.
        await waitFor(() =>
            expect(view.handleChat).toHaveBeenCalledWith(
                {
                    id: "prompt-2",
                    role: "user",
                    content: "edited question",
                    files: undefined,
                    workflow: undefined,
                },
                { linkOnlyToMessageId: "prompt-2" },
            ),
        );
    });

    it("re-points the leaf at the prompt and re-answers it in place", async () => {
        const reloaded: Message[] = [oldPrompt];
        api.setChatLeaf.mockResolvedValue({ leaf: "prompt-1", messages: reloaded });
        api.getChat.mockResolvedValue({ messages: reloaded });
        const view = setup([oldPrompt, oldAnswer]);

        await act(async () => {
            await view.result.current.regenerate({
                assistant: oldAnswer,
                parentUser: oldPrompt,
            });
        });

        expect(api.setChatLeaf).toHaveBeenCalledWith("chat-1", "prompt-1");
        expect(view.handleChat).not.toHaveBeenCalled();

        view.rerender({ messages: reloaded });

        await waitFor(() =>
            expect(view.handleChat).toHaveBeenCalledWith(oldPrompt, {
                linkOnlyToMessageId: "prompt-1",
            }),
        );
    });

    it("steps to a sibling through the branch API order", async () => {
        api.fetchSiblings.mockResolvedValue({
            siblings: [
                { id: "a", role: "user", created_at: "", preview: "" },
                { id: "b", role: "user", created_at: "", preview: "" },
            ],
            index: 1,
            total: 2,
        });
        api.setChatLeaf.mockResolvedValue({ leaf: "b", messages: [] });
        api.getChat.mockResolvedValue({ messages: [] });
        const view = setup([oldPrompt]);

        await act(async () => {
            await view.result.current.navigateSibling(
                { id: "a", role: "user", content: "" },
                null,
                1,
            );
        });

        expect(api.fetchSiblings).toHaveBeenCalledWith("chat-1", "a");
        expect(api.setChatLeaf).toHaveBeenCalledWith("chat-1", "b");
        expect(api.getChat).toHaveBeenCalledWith("chat-1");
    });

    it("prefers the sibling ids the view already holds", async () => {
        api.setChatLeaf.mockResolvedValue({ leaf: "b", messages: [] });
        api.getChat.mockResolvedValue({ messages: [] });
        const view = setup([oldPrompt]);

        await act(async () => {
            await view.result.current.navigateSibling(
                { id: "a", role: "user", content: "" },
                ["a", "b"],
                1,
            );
        });

        expect(api.fetchSiblings).not.toHaveBeenCalled();
        expect(api.setChatLeaf).toHaveBeenCalledWith("chat-1", "b");
    });

    it("moves the leaf onto a response for a new thread", async () => {
        api.setChatLeaf.mockResolvedValue({ leaf: "answer-1", messages: [] });
        api.getChat.mockResolvedValue({ messages: [] });
        const view = setup([oldPrompt, oldAnswer]);

        await act(async () => {
            await view.result.current.branchIntoNewThread(oldAnswer);
        });

        expect(api.setChatLeaf).toHaveBeenCalledWith("chat-1", "answer-1");
        expect(api.getChat).toHaveBeenCalledWith("chat-1");
        expect(view.handleChat).not.toHaveBeenCalled();
    });
});