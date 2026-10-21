import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SPOKEN_TEXT_CHARS, recordSpokenAnswer, streamChat, streamProjectChat } from "./mikeApi";

const fetchMock = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
});

const calls = () => fetchMock.mock.calls as [string, RequestInit | undefined][];

describe("voice chat API", () => {
    it("records what was heard of an answer, capped at the server's limit", async () => {
        await expect(recordSpokenAnswer("chat-1", "msg-2", "The lease says")).resolves.toBeUndefined();
        await recordSpokenAnswer("chat-1", "msg-2", "x".repeat(MAX_SPOKEN_TEXT_CHARS + 5));
        const [[url, init], [, long]] = calls();
        expect(String(url)).toMatch(/\/chat\/chat-1\/messages\/msg-2\/spoken$/);
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toEqual({ spokenText: "The lease says" });
        expect(JSON.parse(String(long?.body)).spokenText).toHaveLength(MAX_SPOKEN_TEXT_CHARS);
    });

    it("marks a chat turn as a voice turn", async () => {
        fetchMock.mockImplementation(async () => new Response("", { status: 200 }));
        await streamChat({ messages: [], voice: true });
        await streamProjectChat({ projectId: "p1", messages: [], voice: true });
        await streamChat({ messages: [] });
        const bodies = calls().map(([, init]) => JSON.parse(String(init?.body)));
        expect(bodies[0].voice).toBe(true);
        expect(bodies[1].voice).toBe(true);
        expect(bodies[2]).not.toHaveProperty("voice");
    });
});
