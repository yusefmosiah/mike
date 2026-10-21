import { describe, expect, it } from "vitest";
import { BRAND } from "../../../lib/brand";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import {
    heardAnswerText,
    INTERRUPTED_MARKER,
    MAX_SPOKEN_TEXT_CHARS,
    parseSpokenText,
    replayInterruptedAnswers,
} from "../chat.spoken";
import { VOICE_PROMPT_SECTION, voiceTurnContext } from "../engine/prompts";

const CHAT = "11111111-1111-4111-8111-111111111111";
const U1 = "aaaaaaaa-0000-4000-8000-000000000001";
const A1 = "aaaaaaaa-0000-4000-8000-000000000002";
const U2 = "aaaaaaaa-0000-4000-8000-000000000003";
const A2 = "aaaaaaaa-0000-4000-8000-000000000004";

function row(id: string, role: string, parent: string | null, content: unknown, at: string) {
    return { id, role, content, files: null, workflow: null, parent_message_id: parent, created_at: at };
}
const PATH_ROWS = [
    row(U1, "user", null, "What is the notice period?", "2026-10-20T10:00:00Z"),
    row(A1, "assistant", U1, [{ type: "content", text: "Ninety days. Clause 4 also says notice must be in writing, and..." }], "2026-10-20T10:00:01Z"),
    row(U2, "user", A1, "And the rent?", "2026-10-20T10:01:00Z"),
    row(A2, "assistant", U2, [{ type: "content", text: "The rent is two thousand a month." }], "2026-10-20T10:01:01Z"),
];

describe("the voice prompt section", () => {
    it("asks for short spoken answers and keeps cite tags working", () => {
        expect(VOICE_PROMPT_SECTION).toMatch(/one or two short sentences/);
        expect(VOICE_PROMPT_SECTION).toMatch(/no Markdown/);
        expect(VOICE_PROMPT_SECTION).toMatch(/tables, code/);
        expect(VOICE_PROMPT_SECTION).toMatch(/URLs/);
        expect(VOICE_PROMPT_SECTION).toMatch(/one question at a time/);
        expect(VOICE_PROMPT_SECTION).toMatch(/clause 4 of the lease/);
        expect(VOICE_PROMPT_SECTION).toMatch(/Keep writing cite tags/);
        expect(VOICE_PROMPT_SECTION).toMatch(/read naturally aloud/);
        expect(VOICE_PROMPT_SECTION).not.toContain(BRAND.name);
    });

    it("is turn context for a voice turn only", () => {
        expect(voiceTurnContext(true)).toEqual([{ key: "voice", text: VOICE_PROMPT_SECTION }]);
        expect(voiceTurnContext(false)).toEqual([]);
        expect(voiceTurnContext(undefined)).toEqual([]);
    });
});

describe("spoken text", () => {
    it("accepts a string up to the cap, including an empty one", () => {
        expect(parseSpokenText({ spokenText: "Ninety days." })).toEqual({ ok: true, value: "Ninety days." });
        expect(parseSpokenText({ spokenText: "" })).toEqual({ ok: true, value: "" });
        expect(parseSpokenText({ spokenText: "x".repeat(MAX_SPOKEN_TEXT_CHARS) }).ok).toBe(true);
    });

    it.each([[{}], [{ spokenText: 3 }], [{ spokenText: null }], [null], [["a"]], [{ spokenText: "x".repeat(MAX_SPOKEN_TEXT_CHARS + 1) }]])(
        "rejects %j",
        (body) => {
            expect(parseSpokenText(body).ok).toBe(false);
        },
    );

    it("replays as the spoken prefix and a marker", () => {
        expect(heardAnswerText("Ninety days.")).toBe(`Ninety days.\n\n${INTERRUPTED_MARKER}`);
        expect(heardAnswerText("  ")).toBe(INTERRUPTED_MARKER);
    });
});

describe("replayInterruptedAnswers", () => {
    const history = [
        { role: "user", content: "What is the notice period?" },
        { role: "assistant", content: "Ninety days. Clause 4 also says notice must be in writing, and..." },
        { role: "user", content: "And the rent?" },
        { role: "assistant", content: "The rent is two thousand a month." },
        { role: "user", content: "Thanks" },
    ];

    it("replaces an interrupted answer with what was heard, and tells the runtime about an interrupted parent", async () => {
        const fake = scriptedDb([
            { table: "chat_messages", data: [{ id: A2, spoken_text: "The rent is" }] },
            { table: "chat_messages", data: PATH_ROWS },
        ]);
        const result = await replayInterruptedAnswers(fake.db, { chatId: CHAT, parentMessageId: A2, messages: history });
        fake.done();
        expect(result.parentHeard).toBe(`The rent is\n\n${INTERRUPTED_MARKER}`);
        expect(result.messages[3].content).toBe(`The rent is\n\n${INTERRUPTED_MARKER}`);
        expect(result.messages[1].content).toBe(history[1].content);
        // The request's history itself is left alone.
        expect(history[3].content).toBe("The rent is two thousand a month.");
        // Only interrupted answers of this chat are read.
        expect(fake.calls[0].filters).toEqual(
            expect.arrayContaining([
                ["eq", "chat_id", CHAT],
                ["eq", "role", "assistant"],
            ]),
        );
    });

    it("replays an older interrupted answer on the path, without marking the parent", async () => {
        const fake = scriptedDb([
            { table: "chat_messages", data: [{ id: A1, spoken_text: "Ninety days." }] },
            { table: "chat_messages", data: PATH_ROWS },
        ]);
        const result = await replayInterruptedAnswers(fake.db, { chatId: CHAT, parentMessageId: A2, messages: history });
        expect(result.parentHeard).toBeUndefined();
        expect(result.messages[1].content).toBe(`Ninety days.\n\n${INTERRUPTED_MARKER}`);
        expect(result.messages[3].content).toBe(history[3].content);
    });

    it("pairs by text, not position: a history missing a stored answer leaves the others alone", async () => {
        // The client never received A2 (say, a colleague's turn in a shared
        // thread): pairing from the newest back would put A2's spoken text on
        // A1's answer.
        const short = [history[0], history[1], { role: "user", content: "Thanks" }];
        const fake = scriptedDb([
            { table: "chat_messages", data: [{ id: A2, spoken_text: "The rent is" }] },
            { table: "chat_messages", data: PATH_ROWS },
        ]);
        const result = await replayInterruptedAnswers(fake.db, { chatId: CHAT, parentMessageId: A2, messages: short });
        expect(result.messages).toEqual(short);
        // The runtime still learns its parent was interrupted: that is by id.
        expect(result.parentHeard).toBe(`The rent is\n\n${INTERRUPTED_MARKER}`);
    });

    it("matches text despite whitespace differences, and skips answers it cannot identify", async () => {
        const fake = scriptedDb([
            { table: "chat_messages", data: [{ id: A2, spoken_text: "The rent is" }] },
            { table: "chat_messages", data: PATH_ROWS },
        ]);
        const odd = [
            ...history.slice(0, 3),
            { role: "assistant", content: "  The rent is two\nthousand a month. " },
            { role: "assistant", content: "Something the server never stored." },
            { role: "user", content: "Thanks" },
        ];
        const result = await replayInterruptedAnswers(fake.db, { chatId: CHAT, parentMessageId: A2, messages: odd });
        expect(result.messages[3].content).toBe(`The rent is\n\n${INTERRUPTED_MARKER}`);
        expect(result.messages[4].content).toBe("Something the server never stored.");
    });

    it("leaves an answer whole when the same text was interrupted once and heard in full once", async () => {
        const same = [{ type: "content", text: "Yes." }];
        const rows = [
            row(U1, "user", null, "Is it signed?", "2026-10-20T10:00:00Z"),
            row(A1, "assistant", U1, same, "2026-10-20T10:00:01Z"),
            row(U2, "user", A1, "Is it dated?", "2026-10-20T10:01:00Z"),
            row(A2, "assistant", U2, same, "2026-10-20T10:01:01Z"),
        ];
        const fake = scriptedDb([
            { table: "chat_messages", data: [{ id: A2, spoken_text: "" }] },
            { table: "chat_messages", data: rows },
        ]);
        const messages = [
            { role: "user", content: "Is it signed?" },
            { role: "assistant", content: "Yes." },
            { role: "user", content: "Is it dated?" },
            { role: "assistant", content: "Yes." },
            { role: "user", content: "Thanks" },
        ];
        const result = await replayInterruptedAnswers(fake.db, { chatId: CHAT, parentMessageId: A2, messages });
        expect(result.messages).toEqual(messages);
    });

    it("reads nothing more when the chat has no interrupted answer", async () => {
        const fake = scriptedDb([{ table: "chat_messages", data: [] }]);
        const result = await replayInterruptedAnswers(fake.db, { chatId: CHAT, parentMessageId: A2, messages: history });
        fake.done();
        expect(result).toEqual({ messages: history });
    });

    it("keeps the full history when the lookup fails", async () => {
        const fake = scriptedDb([{ table: "chat_messages", error: { message: "boom" } }]);
        const result = await replayInterruptedAnswers(fake.db, { chatId: CHAT, parentMessageId: A2, messages: history });
        expect(result).toEqual({ messages: history });
    });

    it("does nothing for a chat's first message", async () => {
        const fake = scriptedDb([]);
        const result = await replayInterruptedAnswers(fake.db, { chatId: CHAT, parentMessageId: null, messages: history });
        fake.done();
        expect(result).toEqual({ messages: history });
    });
});
