import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    chatQueueKey,
    readChatQueue,
    type ChatQueueDraft,
} from "@/app/lib/chatQueue";
import { useChatQueue, type ChatQueueController } from "./useChatQueue";

function wait(ms: number) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}

const draft = (text: string): ChatQueueDraft => ({
    text,
    docs: [],
    workflow: null,
    model: "gpt-5.6-sol",
    effort: "high",
});

function Harness({
    chatKey,
    isStreaming,
    send,
    onQueue,
}: {
    chatKey: string;
    isStreaming: boolean;
    send: (entry: { text: string }) => void | Promise<unknown>;
    onQueue: (queue: ChatQueueController) => void;
}) {
    const queue = useChatQueue(chatKey, { send, isStreaming });
    onQueue(queue);
    return null;
}

function renderQueue({
    chatKey = "chat-1",
    isStreaming = false,
    send = vi.fn(),
}: {
    chatKey?: string;
    isStreaming?: boolean;
    send?: (entry: { text: string }) => void | Promise<unknown>;
} = {}) {
    const latest: { queue: ChatQueueController | null } = { queue: null };
    const onQueue = (queue: ChatQueueController) => {
        latest.queue = queue;
    };
    const view = render(
        <Harness
            chatKey={chatKey}
            isStreaming={isStreaming}
            send={send}
            onQueue={onQueue}
        />,
    );
    return {
        queue: () => {
            if (!latest.queue) throw new Error("queue not mounted");
            return latest.queue;
        },
        rerender: (next: {
            chatKey?: string;
            isStreaming?: boolean;
            send?: (entry: { text: string }) => void | Promise<unknown>;
        }) =>
            view.rerender(
                <Harness
                    chatKey={next.chatKey ?? chatKey}
                    isStreaming={next.isStreaming ?? isStreaming}
                    send={next.send ?? send}
                    onQueue={onQueue}
                />,
            ),
        unmount: view.unmount,
    };
}

beforeEach(() => localStorage.clear());

describe("useChatQueue", () => {
    it("sends queued entries one at a time, in order", async () => {
        const sent: string[] = [];
        const send = vi.fn((entry: { text: string }) => {
            sent.push(entry.text);
        });
        const view = renderQueue({ send });

        act(() => {
            view.queue().enqueue(draft("one"));
            view.queue().enqueue(draft("two"));
            view.queue().enqueue(draft("three"));
        });

        await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
        expect(sent).toEqual(["one", "two", "three"]);
        expect(readChatQueue("chat-1").entries).toEqual([]);
    });

    it("waits while a turn holds the thread and drains when it ends", async () => {
        const send = vi.fn();
        const view = renderQueue({ isStreaming: true, send });

        act(() => {
            view.queue().enqueue(draft("after the answer"));
        });

        await wait(450);
        expect(send).not.toHaveBeenCalled();

        view.rerender({ isStreaming: false });
        await waitFor(() => expect(send).toHaveBeenCalledOnce());
    });

    it("stops at a pause and only continues after resume", async () => {
        const send = vi.fn();
        const view = renderQueue({ send });

        act(() => {
            view.queue().enqueue(draft("do not send yet"));
            view.queue().pause("stopped");
        });

        await wait(450);
        expect(send).not.toHaveBeenCalled();
        expect(readChatQueue("chat-1").paused?.reason).toBe("stopped");

        act(() => view.queue().resume());
        await waitFor(() => expect(send).toHaveBeenCalledOnce());
        expect(readChatQueue("chat-1").paused).toBeNull();
    });

    it("keeps a paused queue intact across a remount", async () => {
        const first = renderQueue({ isStreaming: true });
        act(() => {
            first.queue().enqueue(draft("survives a close"));
            first.queue().pause("branch");
        });
        first.unmount();

        const second = renderQueue({ isStreaming: true });
        const entries = second.queue().entries;
        expect(entries.map((entry) => entry.text)).toEqual(["survives a close"]);
        expect(second.queue().paused?.reason).toBe("branch");
    });

    it("restores an entry and pauses when the send path rejects", async () => {
        const send = vi
            .fn()
            .mockRejectedValueOnce(new Error("refused"));
        const view = renderQueue({ send });

        act(() => {
            view.queue().enqueue(draft("first"));
            view.queue().enqueue(draft("second"));
        });

        await waitFor(() => expect(view.queue().paused?.reason).toBe("failed"));
        expect(view.queue().entries.map((entry) => entry.text)).toEqual([
            "first",
            "second",
        ]);
        expect(send).toHaveBeenCalledOnce();
    });

    it("pauses without restoring an entry that failed after admission", async () => {
        const send = vi.fn().mockRejectedValueOnce(
            Object.assign(new Error("stream dropped"), {
                restoreQueueEntry: false,
            }),
        );
        const view = renderQueue({ send });

        act(() => {
            view.queue().enqueue(draft("already admitted"));
            view.queue().enqueue(draft("still waiting"));
        });

        await waitFor(() => expect(view.queue().paused?.reason).toBe("failed"));
        expect(view.queue().entries.map((entry) => entry.text)).toEqual([
            "still waiting",
        ]);
        expect(send).toHaveBeenCalledOnce();
    });

    it("keeps mutations in memory when storage writes fail", () => {
        const setItem = vi
            .spyOn(Storage.prototype, "setItem")
            .mockImplementation(() => {
                throw new Error("quota");
            });
        const view = renderQueue({ isStreaming: true });

        act(() => {
            view.queue().enqueue(draft("first"));
            view.queue().enqueue(draft("second"));
        });
        expect(view.queue().entries.map((entry) => entry.text)).toEqual([
            "first",
            "second",
        ]);
        const firstId = view.queue().entries[0].id;
        act(() => view.queue().reorder(firstId, 1));
        expect(view.queue().entries.map((entry) => entry.text)).toEqual([
            "second",
            "first",
        ]);
        act(() => view.queue().remove(firstId));
        expect(view.queue().entries.map((entry) => entry.text)).toEqual([
            "second",
        ]);
        setItem.mockRestore();
    });

    it("moves a new-chat queue onto the id the chat adopted", () => {
        const view = renderQueue({
            chatKey: chatQueueKey({
                userId: "u1",
                chatKey: "new-chat",
            }),
            isStreaming: true,
        });
        act(() => view.queue().enqueue(draft("written before the id")));

        const adopted = chatQueueKey({ userId: "u1", chatKey: "adopted" });
        view.rerender({ chatKey: adopted });

        expect(view.queue().entries.map((entry) => entry.text)).toEqual([
            "written before the id",
        ]);
        expect(readChatQueue(adopted).entries).toHaveLength(1);
        expect(
            readChatQueue(
                chatQueueKey({ userId: "u1", chatKey: "new-chat" }),
            ).entries,
        ).toEqual([]);
    });
});
