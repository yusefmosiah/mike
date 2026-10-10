import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    createBranch,
    fetchChatPath,
    fetchSiblings,
    forkChat,
    getChat,
    getChatSubagentTranscript,
    getVoiceOptions,
    searchProjectDirectory,
    setAutoModeDecisionModel,
    setChatLeaf,
    streamChatTurn,
    synthesizeSpeechDetailed,
    transcribeAudio,
} from "./mikeApi";

// Branch navigation, subagent transcripts, the Auto Mode decision model and
// the voice options: thin wrappers whose request shape and response mapping
// the UI depends on.

const fetchMock = vi.fn();

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const lastCall = () => {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
};

const body = () => JSON.parse(String(lastCall().init.body)) as Record<string, unknown>;

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fetchMock.mockReset();
});

const path = [
    { id: "u1", role: "user", content: "Question", files: null, workflow: null },
    { id: "a1", role: "assistant", content: [{ type: "content", text: "Ans" }, { type: "reasoning", text: "x" }, { type: "content", text: "wer" }] },
    { id: "a2", role: "assistant", content: "legacy text" },
];

describe("branch navigation", () => {
    it("creates a branch and maps the path it returns", async () => {
        fetchMock.mockResolvedValue(json({ new_message_id: "u2", leaf: "u2", path }));
        const created = await createBranch("chat-1", { from_message_id: "u1", content: "Edited" });
        expect(lastCall().url).toBe("/api/chat/chat-1/branches");
        expect(lastCall().init.method).toBe("POST");
        expect(body()).toEqual({ from_message_id: "u1", content: "Edited" });
        expect(created.id).toBe("u2");
        expect(created.leaf).toBe("u2");
        expect(created.messages).toEqual([
            { id: "u1", role: "user", content: "Question", files: undefined, workflow: undefined },
            expect.objectContaining({ id: "a1", role: "assistant", content: "Answer" }),
            expect.objectContaining({ id: "a2", role: "assistant", content: "", events: undefined }),
        ]);
    });

    it("uses the new message as the leaf when the server sends none", async () => {
        fetchMock.mockResolvedValue(json({ new_message_id: "u3", leaf: null, path: [] }));
        expect((await createBranch("chat-1", { from_message_id: "u1" })).leaf).toBe("u3");
    });

    it("moves the caller's leaf", async () => {
        fetchMock.mockResolvedValue(json({ leaf: "a1", path }));
        const page = await setChatLeaf("chat-1", "a1");
        expect(lastCall().url).toBe("/api/chat/chat-1/leaf");
        expect(body()).toEqual({ leaf_message_id: "a1" });
        expect(page.leaf).toBe("a1");
        expect(page.messages).toHaveLength(3);
    });

    it("forks into a new thread", async () => {
        fetchMock.mockResolvedValue(json({ chat_id: "chat-2", leaf: "a1" }));
        expect(await forkChat("chat-1", "a1")).toEqual({ chatId: "chat-2", leaf: "a1" });
        expect(lastCall().url).toBe("/api/chat/chat-1/fork");
        expect(body()).toEqual({ message_id: "a1" });
    });

    it("reads the path for an explicit leaf or the stored one", async () => {
        fetchMock.mockResolvedValue(json({ leaf: "a 1", path: [] }));
        await fetchChatPath("chat-1", "a 1");
        expect(lastCall().url).toBe("/api/chat/chat-1/path?leaf=a%201");
        fetchMock.mockResolvedValue(json({ leaf: null, path }));
        const page = await fetchChatPath("chat-1");
        expect(lastCall().url).toBe("/api/chat/chat-1/path");
        expect(page).toMatchObject({ leaf: null });
    });

    it("lists a message's siblings", async () => {
        const siblings = { siblings: [{ id: "a1", role: "assistant", created_at: "t", preview: "p" }], index: 1, total: 1 };
        fetchMock.mockResolvedValue(json(siblings));
        expect(await fetchSiblings("chat-1", "a1")).toEqual(siblings);
        expect(lastCall().url).toBe("/api/chat/chat-1/branches/a1/siblings");
    });

    it("attaches sibling positions on a chat read, when the server sends them", async () => {
        const chat = { id: "chat-1", title: "T", is_owner: true, access_role: "owner" };
        fetchMock.mockResolvedValue(json({ chat, messages: [...path, { role: "assistant", content: [] }], siblings: { a1: { index: 2, total: 2 } } }));
        const detail = await getChat("chat-1");
        expect(detail.messages.find((m) => m.id === "a1")).toMatchObject({ sibling: { index: 2, total: 2 } });
        expect(detail.messages.find((m) => m.id === "u1")).not.toHaveProperty("sibling");

        fetchMock.mockResolvedValue(json({ chat, messages: path }));
        expect((await getChat("chat-1")).messages.some((m) => "sibling" in m)).toBe(false);
    });

    it("names each prompt's sender and who is generating, on a chat read", async () => {
        const chat = { id: "chat-1", title: "T", is_owner: false, access_role: "editor" };
        fetchMock.mockResolvedValue(json({
            chat,
            messages: [
                { id: "u1", role: "user", content: "a", author_user_id: "partner" },
                { id: "a1", role: "assistant", content: [], author_user_id: "partner" },
                { id: "u2", role: "user", content: "b", author_user_id: "stranger" },
                { id: "u3", role: "user", content: "c" },
                { role: "user", content: "d", author_user_id: "partner" },
            ],
            authors: { partner: { name: "The partner", email: "p@example.com" } },
            generating: { user_id: "partner", since: "t0" },
        }));
        const detail = await getChat("chat-1");
        expect(detail.messages[0].author).toEqual({ id: "partner", name: "The partner", email: "p@example.com" });
        expect(detail.messages[1]).not.toHaveProperty("author");
        expect(detail.messages[2].author).toEqual({ id: "stranger", name: null, email: null });
        expect(detail.messages[3]).not.toHaveProperty("author");
        expect(detail.messages[4]).not.toHaveProperty("author");
        expect(detail.generating).toEqual({ id: "partner", name: "The partner", email: "p@example.com" });

        fetchMock.mockResolvedValue(json({ chat, messages: [], generating: { user_id: null, since: "t0" } }));
        expect((await getChat("chat-1")).generating).toBeNull();
        fetchMock.mockResolvedValue(json({ chat, messages: [] }));
        expect((await getChat("chat-1")).generating).toBeNull();
    });

    it("re-attaches to a turn in a given server incarnation", async () => {
        fetchMock.mockResolvedValue(new Response("", { status: 200 }));
        await streamChatTurn({ chatId: "c", turnId: "t", from: 4, incarnation: "inc-1" });
        expect(lastCall().url).toBe("/api/chat/c/turn/t/stream?from=4&incarnation=inc-1");
    });
});

describe("other thin wrappers", () => {
    it("sets the Auto Mode decision model", async () => {
        fetchMock.mockResolvedValue(json({ model: null }));
        await setAutoModeDecisionModel(null);
        expect(lastCall().url).toBe("/api/user/auto-mode-decision");
        expect(lastCall().init.method).toBe("PUT");
        expect(body()).toEqual({ model: null });
    });

    it("reads a subagent's transcript with an encoded id", async () => {
        fetchMock.mockResolvedValue(json({ id: "child/1", events: [] }));
        await getChatSubagentTranscript("chat-1", "child/1");
        expect(lastCall().url).toBe("/api/chat/chat-1/subagents/child%2F1");
    });

    it("reads the deployment's voice options", async () => {
        fetchMock.mockResolvedValue(json({ operator: {}, openrouter: null }));
        await getVoiceOptions();
        expect(lastCall().url).toBe("/api/audio/options");
    });

    it("searches the project directory with and without paging", async () => {
        fetchMock.mockImplementation(async () => json([]));
        await searchProjectDirectory({ search: "acme", limit: 5, offset: 10 });
        expect(lastCall().url).toBe("/api/projects?view=directory-search&search=acme&limit=5&offset=10");
        await searchProjectDirectory({ search: "acme" });
        expect(lastCall().url).toBe("/api/projects?view=directory-search&search=acme");
    });
});

describe("voice requests", () => {
    class Reader {
        static result: unknown = "data:audio/webm;base64,QUJD";
        result: unknown = null;
        error: Error | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL() {
            this.result = Reader.result;
            queueMicrotask(() => this.onload?.());
        }
    }

    beforeEach(() => {
        Reader.result = "data:audio/webm;base64,QUJD";
        vi.stubGlobal("FileReader", Reader);
    });

    it("names a non-operator provider, model and language, and omits the operator", async () => {
        fetchMock.mockImplementation(async () => json({ text: "hi" }));
        await transcribeAudio(new Blob(["a"], { type: "audio/webm" }), { provider: "openrouter", model: "m", language: "fr" });
        expect(body()).toMatchObject({ provider: "openrouter", model: "m", language: "fr", audio_base64: "QUJD" });
        await transcribeAudio(new Blob(["a"], { type: "audio/webm" }), { provider: "operator" });
        expect(body()).not.toHaveProperty("provider");
        expect(body()).not.toHaveProperty("model");
        expect(body()).not.toHaveProperty("language");
    });

    it("sends an empty payload when the reader returns no text", async () => {
        Reader.result = new ArrayBuffer(1);
        fetchMock.mockResolvedValue(json({ text: "" }));
        await transcribeAudio(new Blob(["a"], { type: "audio/webm" }));
        expect(body().audio_base64).toBe("");
    });

    it("reports who spoke and what it cost, or null when the server does not say", async () => {
        fetchMock.mockResolvedValue(new Response(new Blob(["mp3"]), {
            headers: { "X-Mike-Audio-Provider": "openrouter", "X-Mike-Audio-Model": "kokoro", "X-Mike-Audio-Cost": "0.000045" },
        }));
        const spoken = await synthesizeSpeechDetailed("Hi", { provider: "openrouter", model: "kokoro" });
        expect(body()).toMatchObject({ provider: "openrouter", model: "kokoro" });
        expect(spoken).toMatchObject({ provider: "openrouter", model: "kokoro", costUsd: 0.000045 });

        fetchMock.mockResolvedValue(new Response(new Blob(["mp3"]), { headers: { "X-Mike-Audio-Cost": "n/a" } }));
        expect((await synthesizeSpeechDetailed("Hi", { provider: "operator" })).costUsd).toBeNull();
        expect(body()).not.toHaveProperty("provider");

        fetchMock.mockResolvedValue(new Response(new Blob(["mp3"])));
        expect(await synthesizeSpeechDetailed("Hi")).toMatchObject({ provider: null, model: null, costUsd: null });
    });
});

describe("production logging", () => {
    it("does not log failed responses in a production build", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.resetModules();
        const api = await import("./mikeApi");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        fetchMock.mockResolvedValue(json({ code: "not_found", detail: "Missing" }, 404));
        await expect(api.getVoiceOptions()).rejects.toThrow();
        fetchMock.mockResolvedValue(new Response("<html>", { status: 404, headers: { "Content-Type": "text/html" } }));
        await expect(api.getVoiceOptions()).rejects.toThrow();
        expect(log).not.toHaveBeenCalled();
        log.mockRestore();
    });
});
