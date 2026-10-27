import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import { chatDraftKey, readChatDraft, writeChatDraft } from "./chatDraft";

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

beforeEach(() => localStorage.clear());

describe("chat drafts", () => {
    it("returns nothing for a key with no draft", () => {
        expect(readChatDraft("chat-1")).toBeNull();
    });

    it("round-trips text, documents and a workflow", () => {
        writeChatDraft("chat-1", {
            text: "half-typed question",
            docs: [doc],
            workflow: { id: "wf-1", title: "Review" },
        });
        expect(readChatDraft("chat-1")).toEqual({
            text: "half-typed question",
            docs: [doc],
            workflow: { id: "wf-1", title: "Review" },
        });
    });

    it("keeps each chat's draft separate", () => {
        writeChatDraft("chat-1", { text: "one", docs: [], workflow: null });
        writeChatDraft("chat-2", { text: "two", docs: [], workflow: null });
        writeChatDraft("new-chat", { text: "unsent", docs: [], workflow: null });
        expect(readChatDraft("chat-1")?.text).toBe("one");
        expect(readChatDraft("chat-2")?.text).toBe("two");
        expect(readChatDraft("new-chat")?.text).toBe("unsent");
    });

    it("drops the draft when the composer empties — a sent message", () => {
        writeChatDraft("chat-1", { text: "sent", docs: [doc], workflow: null });
        writeChatDraft("chat-1", { text: "", docs: [], workflow: null });
        expect(readChatDraft("chat-1")).toBeNull();
    });

    it("keeps a draft with attachments but no text", () => {
        writeChatDraft("chat-1", { text: "", docs: [doc], workflow: null });
        expect(readChatDraft("chat-1")?.docs).toHaveLength(1);
    });

    it("survives malformed storage contents", () => {
        // Storage keys are mike.composerDraft.v1:<scoped draft key>.
        localStorage.setItem("mike.composerDraft.v1:chat-1", "not json{");
        expect(readChatDraft("chat-1")).toBeNull();
        localStorage.setItem("mike.composerDraft.v1:chat-2", JSON.stringify(42));
        expect(readChatDraft("chat-2")).toBeNull();
        localStorage.setItem(
            "mike.composerDraft.v1:chat-3",
            JSON.stringify({ text: "ok", docs: "nope", workflow: "nope" }),
        );
        expect(readChatDraft("chat-3")).toEqual({
            text: "ok",
            docs: [],
            workflow: null,
        });
    });

    it("ignores a corrupted draft index rather than failing reads", () => {
        localStorage.setItem("mike.composerDraft.v1:index", "not json{");
        writeChatDraft("chat-1", { text: "kept", docs: [], workflow: null });
        expect(readChatDraft("chat-1")?.text).toBe("kept");
        localStorage.setItem("mike.composerDraft.v1:index", JSON.stringify(7));
        expect(readChatDraft("chat-1")?.text).toBe("kept");
    });

    it("drops non-string entries from a corrupt index", () => {
        // A partial or old-format index must not poison the MRU order.
        localStorage.setItem(
            "mike.composerDraft.v1:index",
            JSON.stringify([7, null, "chat-1"]),
        );
        writeChatDraft("chat-2", { text: "ok", docs: [], workflow: null });
        writeChatDraft("chat-1", { text: "ok", docs: [], workflow: null });
        expect(readChatDraft("chat-1")?.text).toBe("ok");
        expect(readChatDraft("chat-2")?.text).toBe("ok");
    });

    it("still saves when storage reads throw", () => {
        const getItem = vi.spyOn(Storage.prototype, "getItem");
        getItem.mockImplementation(() => {
            throw new Error("denied");
        });
        // Index read throws → empty index; write still lands.
        writeChatDraft("chat-1", { text: "kept", docs: [], workflow: null });
        getItem.mockRestore();
        expect(readChatDraft("chat-1")?.text).toBe("kept");
    });

    it("is a no-op outside the browser", () => {
        // Server render: guards return before touching localStorage.
        const getItem = vi.spyOn(Storage.prototype, "getItem");
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        // Simulate SSR by making localStorage reads see undefined through
        // the typeof guard — vitest's jsdom keeps the global non-configurable.
        const storage = localStorage;
        vi.stubGlobal("localStorage", undefined);
        expect(readChatDraft("chat-1")).toBeNull();
        expect(() =>
            writeChatDraft("chat-1", { text: "x", docs: [], workflow: null }),
        ).not.toThrow();
        vi.stubGlobal("localStorage", storage);
        getItem.mockRestore();
        setItem.mockRestore();
    });

    it("evicts the least recently written drafts past the cap", () => {
        for (let i = 0; i < 101; i++) {
            writeChatDraft(`chat-${i}`, {
                text: `draft ${i}`,
                docs: [],
                workflow: null,
            });
        }
        expect(readChatDraft("chat-0")).toBeNull();
        expect(readChatDraft("chat-100")?.text).toBe("draft 100");
    });

    it("a read draft stays live when rewriting it bumps it past newer ones", () => {
        for (let i = 0; i < 100; i++) {
            writeChatDraft(`chat-${i}`, { text: "d", docs: [], workflow: null });
        }
        // Re-writing chat-0 makes it the most recent, so chat-1 evicts next.
        writeChatDraft("chat-0", { text: "still here", docs: [], workflow: null });
        writeChatDraft("chat-new", { text: "x", docs: [], workflow: null });
        expect(readChatDraft("chat-0")?.text).toBe("still here");
        expect(readChatDraft("chat-1")).toBeNull();
    });
});

describe("chat draft keys", () => {
    it("scopes a draft to account, surface, and chat key", () => {
        expect(
            chatDraftKey({ userId: "u1", projectId: null, chatKey: "chat-1" }),
        ).toBe("u1:global:chat-1");
        expect(
            chatDraftKey({ userId: "u1", projectId: "p9", chatKey: "new:3" }),
        ).toBe("u1:project:p9:new%3A3");
        // A second account or surface never reads the first one's draft.
        writeChatDraft(
            chatDraftKey({ userId: "u1", projectId: "p9", chatKey: "c" }),
            { text: "mine", docs: [], workflow: null },
        );
        expect(
            readChatDraft(
                chatDraftKey({ userId: "u2", projectId: "p9", chatKey: "c" }),
            ),
        ).toBeNull();
        expect(
            readChatDraft(
                chatDraftKey({ userId: "u1", projectId: null, chatKey: "c" }),
            ),
        ).toBeNull();
    });
});
