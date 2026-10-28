import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import {
    adoptChatQueue,
    chatQueueKey,
    clearChatQueue,
    enqueueChatQueue,
    markChatQueuePaused,
    queuedMessage,
    readChatQueue,
    removeChatQueueEntry,
    reorderChatQueue,
    resumeChatQueue,
    writeChatQueue,
    type ChatQueueDraft,
} from "./chatQueue";

const doc: Document = {
    id: "d1",
    filename: "Lease.pdf",
    file_type: "pdf",
    project_id: null,
    storage_path: null,
    pdf_storage_path: null,
    size_bytes: null,
    page_count: null,
    structure_tree: null,
    status: "ready",
    created_at: null,
    current_version_id: "v1",
    active_version_number: 2,
};

const draft = (text: string, overrides: Partial<ChatQueueDraft> = {}): ChatQueueDraft => ({
    text,
    docs: [],
    workflow: null,
    model: "gpt-5.6-sol",
    effort: "high",
    ...overrides,
});

beforeEach(() => localStorage.clear());

describe("chat queue persistence", () => {
    it("returns an empty queue for a key that was never written", () => {
        expect(readChatQueue("chat-1")).toEqual({ entries: [], paused: null });
    });

    it("round-trips an entry with its attachments, workflow and stamp", () => {
        enqueueChatQueue(
            "chat-1",
            draft("Check the notice period", {
                docs: [doc],
                workflow: { id: "w1", title: "Review lease" },
                model: "claude-sonnet-5",
                effort: "xhigh",
            }),
        );

        const queue = readChatQueue("chat-1");
        expect(queue.entries).toHaveLength(1);
        expect(queue.entries[0]).toMatchObject({
            text: "Check the notice period",
            docs: [doc],
            workflow: { id: "w1", title: "Review lease" },
            model: "claude-sonnet-5",
            effort: "xhigh",
            status: "queued",
        });
        expect(queue.entries[0].stampedAt).toEqual(expect.any(Number));
        expect(queue.entries[0].id).toEqual(expect.any(String));
    });

    it("keeps entries in the order they were written", () => {
        enqueueChatQueue("chat-1", draft("one"));
        enqueueChatQueue("chat-1", draft("two"));
        enqueueChatQueue("chat-1", draft("three"));

        expect(readChatQueue("chat-1").entries.map((entry) => entry.text)).toEqual([
            "one",
            "two",
            "three",
        ]);
    });

    it("reorders one place and clamps at the ends", () => {
        enqueueChatQueue("chat-1", draft("one"));
        enqueueChatQueue("chat-1", draft("two"));
        const [first, second] = readChatQueue("chat-1").entries;

        reorderChatQueue("chat-1", second.id, -1);
        expect(readChatQueue("chat-1").entries.map((entry) => entry.text)).toEqual([
            "two",
            "one",
        ]);

        reorderChatQueue("chat-1", second.id, -1);
        expect(readChatQueue("chat-1").entries.map((entry) => entry.text)).toEqual([
            "two",
            "one",
        ]);

        reorderChatQueue("chat-1", first.id, 1);
        expect(readChatQueue("chat-1").entries.map((entry) => entry.text)).toEqual([
            "two",
            "one",
        ]);
    });

    it("removes or clears entries without touching other chats", () => {
        enqueueChatQueue("chat-1", draft("one"));
        enqueueChatQueue("chat-1", draft("two"));
        enqueueChatQueue("chat-2", draft("elsewhere"));
        const [first] = readChatQueue("chat-1").entries;

        removeChatQueueEntry("chat-1", first.id);
        expect(readChatQueue("chat-1").entries.map((entry) => entry.text)).toEqual(["two"]);
        expect(readChatQueue("chat-2").entries).toHaveLength(1);

        clearChatQueue("chat-1");
        expect(readChatQueue("chat-1")).toEqual({ entries: [], paused: null });
        expect(readChatQueue("chat-2").entries).toHaveLength(1);
        expect(localStorage.getItem("mike.composerQueue.v1:chat-1")).toBeNull();
    });

    it("keeps a paused queue until it is resumed", () => {
        enqueueChatQueue("chat-1", draft("one"));
        markChatQueuePaused("chat-1", "stopped");

        expect(readChatQueue("chat-1").paused?.reason).toBe("stopped");

        // A message written while paused joins the queue but does not resume it.
        enqueueChatQueue("chat-1", draft("two"));
        expect(readChatQueue("chat-1").paused?.reason).toBe("stopped");
        expect(readChatQueue("chat-1").entries).toHaveLength(2);

        resumeChatQueue("chat-1");
        expect(readChatQueue("chat-1").paused).toBeNull();
        expect(readChatQueue("chat-1").entries).toHaveLength(2);
    });

    it("does not pause an empty queue", () => {
        markChatQueuePaused("chat-1", "failed");
        expect(readChatQueue("chat-1")).toEqual({ entries: [], paused: null });
    });

    it("drops a pause when the last entry is removed", () => {
        enqueueChatQueue("chat-1", draft("one"));
        markChatQueuePaused("chat-1", "branch");
        const [entry] = readChatQueue("chat-1").entries;

        removeChatQueueEntry("chat-1", entry.id);
        expect(readChatQueue("chat-1")).toEqual({ entries: [], paused: null });
    });

    it("resets a half-sent entry to queued when reloaded", () => {
        localStorage.setItem(
            "mike.composerQueue.v1:chat-1",
            JSON.stringify({
                entries: [
                    {
                        id: "e1",
                        text: "still here",
                        docs: [],
                        workflow: null,
                        model: null,
                        effort: null,
                        stampedAt: 1,
                        status: "sending",
                    },
                ],
                paused: null,
            }),
        );

        expect(readChatQueue("chat-1").entries[0].status).toBe("queued");
    });

    it("survives malformed storage", () => {
        localStorage.setItem("mike.composerQueue.v1:chat-1", "{not json");
        expect(readChatQueue("chat-1")).toEqual({ entries: [], paused: null });

        localStorage.setItem(
            "mike.composerQueue.v1:chat-1",
            JSON.stringify({ entries: [null, { id: 1 }, { id: "e1", text: 2 }] }),
        );
        expect(readChatQueue("chat-1")).toEqual({ entries: [], paused: null });
    });

    it("writes nothing for an empty queue", () => {
        writeChatQueue("chat-1", { entries: [], paused: null });
        expect(localStorage.getItem("mike.composerQueue.v1:chat-1")).toBeNull();
    });

    it("ignores a corrupted queue index and a throwing read", () => {
        localStorage.setItem("mike.composerQueue.v1:index", "{not json");
        enqueueChatQueue("chat-1", draft("kept"));
        expect(readChatQueue("chat-1").entries).toHaveLength(1);

        localStorage.setItem("mike.composerQueue.v1:index", JSON.stringify(7));
        localStorage.setItem("mike.composerQueue.v1:index", JSON.stringify([1, null, "chat-2"]));
        enqueueChatQueue("chat-2", draft("also kept"));
        expect(readChatQueue("chat-2").entries).toHaveLength(1);
    });

    it("still queues when storage writes throw", () => {
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        const removeItem = vi.spyOn(Storage.prototype, "removeItem");
        setItem.mockImplementation(() => { throw new Error("quota"); });
        removeItem.mockImplementation(() => { throw new Error("denied"); });
        // Index write and eviction cleanup both throw; the returned queue
        // still carries the entry even though nothing persisted.
        const state = enqueueChatQueue("chat-1", draft("kept"));
        setItem.mockRestore();
        removeItem.mockRestore();
        expect(state.entries).toHaveLength(1);
        // A later write lands on its own: the entry lost to the failed
        // write is not replayed from storage it never reached.
        enqueueChatQueue("chat-1", draft("more"));
        expect(readChatQueue("chat-1").entries.map((e) => e.text)).toEqual(["more"]);
    });

    it("drops an unrecognized pause reason when reloaded", () => {
        const entries = [{ id: "e1", text: "x", docs: [], workflow: null, model: null, effort: null, stampedAt: 1, status: "queued" }];
        localStorage.setItem(
            "mike.composerQueue.v1:chat-1",
            JSON.stringify({ entries, paused: { reason: "mystery", at: 1 } }),
        );
        expect(readChatQueue("chat-1").paused).toBeNull();

        localStorage.setItem(
            "mike.composerQueue.v1:chat-1",
            JSON.stringify({ entries, paused: { reason: "stopped", at: "not-a-number" } }),
        );
        expect(readChatQueue("chat-1").paused?.reason).toBe("stopped");
    });

    it("treats a non-array queue index and non-array entries as empty", () => {
        localStorage.setItem("mike.composerQueue.v1:index", JSON.stringify("x"));
        enqueueChatQueue("chat-1", draft("kept"));
        expect(readChatQueue("chat-1").entries).toHaveLength(1);
        localStorage.setItem(
            "mike.composerQueue.v1:chat-2",
            JSON.stringify({ entries: "nope", paused: null }),
        );
        expect(readChatQueue("chat-2")).toEqual({ entries: [], paused: null });
    });

    it("is a no-op outside the browser", () => {
        const storage = localStorage;
        vi.stubGlobal("localStorage", undefined);
        expect(readChatQueue("chat-1")).toEqual({ entries: [], paused: null });
        expect(() => writeChatQueue("chat-1", { entries: [], paused: null })).not.toThrow();
        vi.stubGlobal("localStorage", storage);
    });

    it("keeps mark/resume idempotent: empty queue, same reason, unpaused", () => {
        expect(markChatQueuePaused("chat-empty", "stopped").paused).toBeNull();
        enqueueChatQueue("chat-1", draft("x"));
        markChatQueuePaused("chat-1", "stopped");
        const at = readChatQueue("chat-1").paused?.at;
        markChatQueuePaused("chat-1", "stopped");
        expect(readChatQueue("chat-1").paused?.at).toBe(at);
        expect(resumeChatQueue("chat-2").paused).toBeNull();
        resumeChatQueue("chat-1");
        expect(readChatQueue("chat-1").paused).toBeNull();
    });

    it("tolerates an evicted-key removal throwing during MRU cleanup", () => {
        // Fill the index to capacity, then evict while removeItem throws.
        localStorage.setItem(
            "mike.composerQueue.v1:index",
            JSON.stringify(Array.from({ length: 100 }, (_, i) => `chat-old-${i}`)),
        );
        const removeItem = vi.spyOn(Storage.prototype, "removeItem");
        removeItem.mockImplementation(() => { throw new Error("denied"); });
        enqueueChatQueue("chat-new", draft("x"));
        removeItem.mockRestore();
        expect(readChatQueue("chat-new").entries).toHaveLength(1);
    });

    it("treats a stored non-object as an empty queue", () => {
        localStorage.setItem("mike.composerQueue.v1:chat-1", JSON.stringify(42));
        localStorage.setItem("mike.composerQueue.v1:chat-2", JSON.stringify(null));
        expect(readChatQueue("chat-1")).toEqual({ entries: [], paused: null });
        expect(readChatQueue("chat-2")).toEqual({ entries: [], paused: null });
    });

    it("normalizes entries with wrong-typed fields on reload", () => {
        localStorage.setItem(
            "mike.composerQueue.v1:chat-1",
            JSON.stringify({
                entries: [{
                    id: "e1", text: "x",
                    docs: "nope",
                    workflow: { id: "w", title: 9 },
                    model: 4, effort: "hyper", stampedAt: "when",
                }],
                paused: null,
            }),
        );
        const [entry] = readChatQueue("chat-1").entries;
        expect(entry).toMatchObject({
            docs: [], workflow: { id: "w", title: "" },
            model: null, effort: null,
        });
        expect(typeof entry.stampedAt).toBe("number");
    });

    it("builds a queued message for a doc without version info", () => {
        const message = queuedMessage({
            id: "e1", text: "x",
            docs: [{ ...doc, current_version_id: null, active_version_number: null }],
            workflow: null, model: null, effort: null, stampedAt: 1, status: "queued",
        });
        expect(message.files).toEqual([{ filename: "Lease.pdf", document_id: "d1" }]);
    });
});

describe("chat queue keys", () => {
    it("scopes a queue to the account, surface and chat", () => {
        const global = chatQueueKey({ userId: "u1", chatKey: "c1" });
        const project = chatQueueKey({ userId: "u1", projectId: "p1", chatKey: "c1" });
        const otherUser = chatQueueKey({ userId: "u2", chatKey: "c1" });
        const otherChat = chatQueueKey({ userId: "u1", chatKey: "c2" });

        enqueueChatQueue(global, draft("global"));
        enqueueChatQueue(project, draft("project"));
        enqueueChatQueue(otherUser, draft("other user"));
        enqueueChatQueue(otherChat, draft("other chat"));

        expect(readChatQueue(global).entries.map((entry) => entry.text)).toEqual([
            "global",
        ]);
        expect(readChatQueue(project).entries.map((entry) => entry.text)).toEqual([
            "project",
        ]);
        expect(readChatQueue(otherUser).entries.map((entry) => entry.text)).toEqual([
            "other user",
        ]);
        expect(readChatQueue(otherChat).entries.map((entry) => entry.text)).toEqual([
            "other chat",
        ]);
    });
});

describe("adopting a new chat's queue", () => {
    it("moves a new-chat queue onto the id the chat adopted", () => {
        const from = chatQueueKey({ userId: "u1", chatKey: "new-chat" });
        const to = chatQueueKey({ userId: "u1", chatKey: "adopted" });
        enqueueChatQueue(from, draft("written before the id"));
        markChatQueuePaused(from, "failed");

        const moved = adoptChatQueue(from, to);

        expect(moved.entries.map((entry) => entry.text)).toEqual([
            "written before the id",
        ]);
        expect(moved.paused?.reason).toBe("failed");
        expect(readChatQueue(from)).toEqual({ entries: [], paused: null });
        expect(readChatQueue(to).entries).toHaveLength(1);
    });

    it("never overwrites the queue the target chat already had", () => {
        const from = chatQueueKey({ userId: "u1", chatKey: "new-chat" });
        const to = chatQueueKey({ userId: "u1", chatKey: "existing" });
        enqueueChatQueue(from, draft("new chat queue"));
        enqueueChatQueue(to, draft("existing queue"));

        adoptChatQueue(from, to);

        expect(readChatQueue(to).entries.map((entry) => entry.text)).toEqual([
            "existing queue",
        ]);
        expect(readChatQueue(from).entries).toHaveLength(1);
    });
});

describe("queued messages", () => {
    it("send with the model, effort and attachments stamped at queue time", () => {
        enqueueChatQueue(
            "chat-1",
            draft("Stamped", {
                docs: [doc],
                workflow: { id: "w1", title: "Review lease" },
                model: "claude-sonnet-5",
                effort: "low",
            }),
        );
        const [entry] = readChatQueue("chat-1").entries;

        expect(queuedMessage(entry)).toEqual({
            role: "user",
            content: "Stamped",
            files: [
                {
                    filename: "Lease.pdf",
                    document_id: "d1",
                    version_id: "v1",
                    version_number: 2,
                },
            ],
            workflow: { id: "w1", title: "Review lease" },
            model: "claude-sonnet-5",
            reasoning: "low",
        });
    });

    it("carry the no-reply flag for /nr entries", () => {
        enqueueChatQueue("chat-1", draft("A note", { noResponse: true }));
        const [entry] = readChatQueue("chat-1").entries;

        expect(queuedMessage(entry)).toMatchObject({
            role: "user",
            content: "A note",
            noResponse: true,
        });
    });

    it("omit an empty model rather than clearing it on the turn", () => {
        enqueueChatQueue("chat-1", draft("A note", { model: null, effort: null }));
        const [entry] = readChatQueue("chat-1").entries;

        expect(queuedMessage(entry)).not.toHaveProperty("model");
        expect(queuedMessage(entry)).not.toHaveProperty("reasoning");
    });
});
