import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MikeClient, readSse } from "./client.mts";
import { historyMessages, mapFiles, runReplay } from "./runner.mts";
import type { AssistantEvent, ExtractedThread, SeedMap } from "./types.mts";
import { emptyMetrics } from "./metrics.mts";

function body(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(enc.encode(c));
            controller.close();
        },
    });
}

describe("SSE reader", () => {
    it("reassembles records split across chunks and keeps their ids", async () => {
        const frames = [];
        for await (const f of readSse(body(['id: 1\ndata: {"type":"chat', '_id","chatId":"c"}\n\nid: 2\r\ndata: not json\n\n', "data: [DONE]\n\n", 'data: {"type":"after"}\n\n']))) frames.push(f);
        expect(frames).toEqual([
            { id: "1", data: { type: "chat_id", chatId: "c" } },
            { id: "2", data: { type: "unparsed", raw: "not json" } },
            { id: null, data: "[DONE]" },
        ]);
    });

    it("yields a final record without a trailing blank line", async () => {
        const frames = [];
        for await (const f of readSse(body(['data: {"type":"x"}']))) frames.push(f);
        expect(frames).toEqual([{ id: null, data: { type: "x" } }]);
    });
});

describe("history and attachments", () => {
    it("sends assistant rows as their visible text, like the web app", () => {
        expect(historyMessages([
            { id: "u", role: "user", content: "hi", files: [{ filename: "a.docx", document_id: "d" }] },
            { id: "a", role: "assistant", content: [{ type: "reasoning", text: "x" }, { type: "content", text: "Hello" }, { type: "content", text: "!" }] },
        ])).toEqual([
            { role: "user", content: "hi", files: [{ filename: "a.docx", document_id: "d" }] },
            { role: "assistant", content: "Hello!" },
        ]);
    });

    it("maps attachments through the seed map by version, then document", () => {
        const seed: SeedMap = { format: "mike-replay-seed/1", documents: { v1: { filename: "a.docx", document_id: "n1", version_id: "nv1" }, d2: { filename: "b.pdf", document_id: "n2" } }, workflows: {}, memory: null };
        expect(mapFiles([{ filename: "a.docx", document_id: "d1", version_id: "v1" }, { filename: "b.pdf", document_id: "d2", version_id: "v2" }, { filename: "c.md", document_id: "d3" }], seed)).toEqual({
            files: [{ filename: "a.docx", document_id: "n1", version_id: "nv1" }, { filename: "b.pdf", document_id: "n2" }],
            dropped: [{ filename: "c.md", document_id: "d3" }],
        });
    });
});

/**
 * A fake Mike behind fetch: one chat, a first turn that pauses on
 * ask_inputs, and a second turn whose stream drops and is resumed.
 */
function fakeMike() {
    const rows: { id: string; role: "user" | "assistant"; content: string | AssistantEvent[] }[] = [];
    const requests: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = [];
    let turn = 0;
    const sse = (frames: string[]) => new Response(body(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
    const frame = (id: number, data: unknown) => `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
        const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        const p = url.pathname.replace(/^\/api/, "");
        requests.push({ method, path: `${p}${url.search}`, body: reqBody, headers });
        if (p === "/auth/login") return new Response(JSON.stringify({ user: { id: "sim" } }), { headers: { "set-cookie": "sb-auth=tok; Path=/; HttpOnly" } });
        if (headers.Cookie !== "sb-auth=tok") return new Response("{}", { status: 401 });
        if (p === "/user/autocompact") return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
        if (p === "/chat/create") return Response.json({ id: "chat1" });
        if (p === "/chat/chat1" && method === "GET") return Response.json({ messages: rows, active_turn: null, generating: null });
        if (p === "/chat" && method === "POST") {
            const b = reqBody as { ask_inputs_response?: { ask_event_id: string; responses: unknown[] }; messages: { content: string }[] };
            if (b.ask_inputs_response) {
                const a = rows.find((r) => r.id === "a1")!;
                (a.content as AssistantEvent[]).push(
                    { type: "ask_inputs_response", assistant_message_id: "a1", ask_event_id: b.ask_inputs_response.ask_event_id, responses: b.ask_inputs_response.responses as never },
                    { type: "content", text: " Memo written." },
                );
                return sse([frame(1, { type: "content_delta", text: " Memo written." }), "data: [DONE]\n\n"]);
            }
            turn += 1;
            const prompt = b.messages[b.messages.length - 1]!.content;
            rows.push({ id: `u${turn}`, role: "user", content: prompt });
            if (turn === 1) {
                rows.push({ id: "a1", role: "assistant", content: [
                    { type: "content", text: "Which format?" },
                    { type: "ask_inputs", event_id: "e1", items: [{ id: "q1", kind: "choice", question: "Format?", options: [{ value: "Memo" }, { value: "Doc" }], allow_other: false, other_label: "Other" }] },
                ] });
                return sse([frame(1, { type: "stream_incarnation", incarnation: "11111111-1111-1111-1111-111111111111" }), frame(2, { type: "chat_id", chatId: "chat1", turnId: "t1", assistantMessageId: "a1", userMessageId: "u1" }), "data: [DONE]\n\n"]);
            }
            rows.push({ id: "a2", role: "assistant", content: [{ type: "content", text: "Part one, part two." }, { type: "turn_usage", input: 10, output: 5, cost: 0 }] });
            // The connection drops before [DONE].
            return sse([frame(1, { type: "chat_id", chatId: "chat1", turnId: "t2", assistantMessageId: "a2", userMessageId: "u2" }), frame(2, { type: "content_delta", text: "Part one," })]);
        }
        if (p === "/chat/chat1/turn/t2/stream") {
            return sse([frame(3, { type: "content_delta", text: " part two." }), "data: [DONE]\n\n"]);
        }
        return new Response(JSON.stringify({ detail: `unexpected ${method} ${p}` }), { status: 500 });
    };
    return { fetchImpl, requests, rows };
}

const thread: ExtractedThread = {
    format: "mike-replay-thread/1",
    source: "msgs.json",
    leafId: "x",
    t0: "2026-10-11T19:52:37Z",
    t1: "2026-10-11T20:52:37Z",
    offPathMessages: 0,
    model: null,
    turns: [
        {
            index: 1, messageId: "o1", createdAt: "", content: "Write it up", files: [{ filename: "pack.docx", document_id: "d", version_id: "v" }], workflow: null, assistantMessageId: "oa1",
            asks: [{ assistantMessageId: "oa1", eventId: "oe1", items: [], responses: [{ id: "old", kind: "choice", question: "Format?", answer: "memo" }] }],
            answer: "", reasoning: "", metrics: emptyMetrics(),
        },
        { index: 2, messageId: "o2", createdAt: "", content: "Continue", files: [], workflow: null, assistantMessageId: "oa2", asks: [], answer: "", reasoning: "", metrics: emptyMetrics() },
    ],
};

describe("runReplay", () => {
    it("replays prompts, answers ask_inputs from the original, resumes a dropped stream and records it all", async () => {
        const fake = fakeMike();
        const client = new MikeClient({ origin: "https://mike.test/app", fetchImpl: fake.fetchImpl });
        await client.login("sim@example.com", "pw");
        const outDir = mkdtempSync(path.join(tmpdir(), "replay-run-"));
        const logs: string[] = [];
        const state = await runReplay(client, {
            thread,
            seed: { format: "mike-replay-seed/1", documents: { v: { filename: "pack.docx", document_id: "nd", version_id: "nv" } }, workflows: {}, memory: null },
            outDir,
            model: "m1",
            reasoning: "high",
            delayMs: 0,
            retry: false,
            maxAskRounds: 3,
            timeZone: "America/New_York",
            autocompact: 50_000,
            dropUnmappedWorkflows: false,
            downloadDocs: false,
            turnTimeoutMs: 1_000,
            log: (m) => logs.push(m),
            sleep: async () => {},
        });
        expect(state).toMatchObject({ chatId: "chat1", completed: [1, 2], failed: [], nextTurn: 3 });
        expect(logs.join("\n")).toMatch(/autocompact endpoint not available/);

        const posts = fake.requests.filter((r) => r.method === "POST" && r.path === "/chat");
        expect(posts).toHaveLength(3);
        expect(posts.every((r) => r.headers.Origin === "https://mike.test")).toBe(true);
        expect(posts[0]!.body).toMatchObject({ chat_id: "chat1", model: "m1", reasoning: "high", time_zone: "America/New_York", messages: [{ role: "user", content: "Write it up", files: [{ document_id: "nd" }] }] });
        expect(posts[1]!.body).toMatchObject({
            ask_inputs_response: { assistant_message_id: "a1", ask_event_id: "e1", responses: [{ id: "q1", kind: "choice", answer: "Memo" }] },
        });
        const askMessages = (posts[1]!.body as { messages: { role: string; content: string }[] }).messages;
        expect(askMessages.at(-1)).toEqual({ role: "user", content: "Responses to your questions:\n1. Format?\nMemo" });
        expect((posts[2]!.body as { messages: unknown[] }).messages).toHaveLength(3);
        expect(fake.requests.some((r) => r.path === "/chat/chat1/turn/t2/stream?from=3")).toBe(true);

        const t1 = JSON.parse(readFileSync(path.join(outDir, "turn-001.json"), "utf8"));
        expect(t1.status).toBe("ok");
        expect(t1.asks[0]).toMatchObject({ mappedFrom: "original" });
        expect(t1.assistantMessages[0].content.at(-1)).toEqual({ type: "content", text: " Memo written." });
        const t2 = JSON.parse(readFileSync(path.join(outDir, "turn-002.json"), "utf8"));
        expect(t2.status).toBe("ok");
        expect(t2.attempts[0].reconnects).toBe(1);
        expect(readdirSync(outDir).filter((f) => f.endsWith(".frames.ndjson")).sort()).toEqual([
            "turn-001.0.frames.ndjson",
            "turn-001.1.frames.ndjson",
            "turn-002.0.frames.ndjson",
        ]);
        const frames = readFileSync(path.join(outDir, "turn-002.0.frames.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
        expect(frames.map((f: { seq: number | null }) => f.seq)).toEqual([1, 2, 3, null]);

        // A second invocation resumes from the state file and refuses a different model.
        await expect(runReplay(client, { ...{ thread, seed: null, outDir, model: "other", reasoning: "high", delayMs: 0, retry: false, maxAskRounds: 3, timeZone: "UTC", autocompact: null, dropUnmappedWorkflows: false, downloadDocs: false, turnTimeoutMs: 1, log: () => {} } })).rejects.toThrow(/new --out/);
    });
});

describe("rate limits", () => {
    it("waits as long as a 429 asks, within bounds", async () => {
        const { retryAfterMs } = await import("./client.mts");
        const at = (headers: Record<string, string>) => retryAfterMs({ headers: new Headers(headers) });
        expect(at({ "retry-after": "30" })).toBe(31_000);
        expect(at({ "ratelimit-reset": "2" })).toBe(5_000);
        expect(at({ "retry-after": "5000" })).toBe(15 * 60_000);
        expect(at({})).toBe(61_000);
        expect(at({ "retry-after": "soon" })).toBe(60_000);
    });
});
