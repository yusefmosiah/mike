import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Db } from "../../lib/db";
import { scriptedDb } from "../helpers/scriptedDb";

// PUT /chat/:chatId/messages/:messageId/spoken — hands-free voice chat records
// what the person heard of an answer they interrupted. Same standing as
// stopping that turn: see the chat, write in it, and be the person the answer
// was generated for.

const state = vi.hoisted(() => ({
    db: undefined as Db | undefined,
    chatAccess: vi.fn(),
}));
vi.mock("../../lib/db", () => ({ createDb: () => state.db }));
vi.mock("../../middleware/auth", async () => {
    const { authMock } = await import("../helpers/authMock.js");
    return authMock();
});
vi.mock("../../lib/access", async (original) => ({
    ...(await original<typeof import("../../lib/access")>()),
    ensureChatAccess: state.chatAccess,
}));
import { app } from "../../app";
import { TEST_USER_ID } from "../helpers/authMock";

const CHAT = "11111111-1111-4111-8111-111111111111";
const MESSAGE = "22222222-2222-4222-8222-222222222222";
const PATH = `/chat/${CHAT}/messages/${MESSAGE}/spoken`;
const chatRow = { id: CHAT, title: null, user_id: TEST_USER_ID, project_id: null };

function put(body: unknown, path = PATH) {
    return request(app).put(path).set("Authorization", "Bearer test").send(body as object);
}

beforeEach(() => {
    vi.clearAllMocks();
    state.chatAccess.mockResolvedValue({ ok: true, isCreator: true, projectRole: "owner" });
});

describe("PUT /chat/:chatId/messages/:messageId/spoken", () => {
    it("records what was heard and answers 204", async () => {
        const fake = scriptedDb([
            { table: "chats", data: chatRow },
            { table: "chat_messages", data: { id: MESSAGE, role: "assistant", author_user_id: TEST_USER_ID } },
            { table: "chat_messages", op: "update" },
        ]);
        state.db = fake.db;
        const res = await put({ spokenText: "Ninety days." });
        expect(res.status).toBe(204);
        expect(res.text).toBe("");
        fake.done();
        const lookup = fake.calls[1];
        expect(lookup.filters).toEqual([
            ["eq", "id", MESSAGE],
            ["eq", "chat_id", CHAT],
        ]);
        const update = fake.calls[2];
        expect(update.payload).toEqual({ spoken_text: "Ninety days.", interrupted_at: expect.any(String) });
        expect(update.filters).toEqual([
            ["eq", "id", MESSAGE],
            ["eq", "chat_id", CHAT],
        ]);
    });

    it("accepts an empty spokenText: the person heard nothing", async () => {
        const fake = scriptedDb([
            { table: "chats", data: chatRow },
            { table: "chat_messages", data: { id: MESSAGE, role: "assistant", author_user_id: TEST_USER_ID } },
            { table: "chat_messages", op: "update" },
        ]);
        state.db = fake.db;
        expect((await put({ spokenText: "" })).status).toBe(204);
    });

    it.each([
        [{}, "spokenText must be a string"],
        [{ spokenText: 42 }, "spokenText must be a string"],
        [{ spokenText: "x".repeat(20_001) }, "spokenText must be at most 20000 characters"],
    ])("rejects %#: 400 before touching the database", async (body, detail) => {
        const fake = scriptedDb([]);
        state.db = fake.db;
        const res = await put(body);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ detail });
        fake.done();
    });

    it("answers 404 for a chat the caller cannot see (another user's chat)", async () => {
        state.chatAccess.mockResolvedValue({ ok: false });
        const fake = scriptedDb([{ table: "chats", data: { ...chatRow, user_id: "someone-else" } }]);
        state.db = fake.db;
        const res = await put({ spokenText: "Ninety days." });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ detail: "Chat not found" });
        fake.done();
    });

    it("answers 404 for a chat that does not exist", async () => {
        const fake = scriptedDb([{ table: "chats", data: null }]);
        state.db = fake.db;
        expect((await put({ spokenText: "a" })).status).toBe(404);
    });

    it("answers 403 for a project viewer, who cannot write in the thread", async () => {
        state.chatAccess.mockResolvedValue({ ok: true, isCreator: false, projectRole: "viewer" });
        const fake = scriptedDb([{ table: "chats", data: { ...chatRow, user_id: "someone-else", project_id: "p1" } }]);
        state.db = fake.db;
        const res = await put({ spokenText: "a" });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("chat_write_forbidden");
        fake.done();
    });

    it("answers 403 for an answer generated for someone else in a shared thread", async () => {
        const fake = scriptedDb([
            { table: "chats", data: chatRow },
            { table: "chat_messages", data: { id: MESSAGE, role: "assistant", author_user_id: "colleague" } },
        ]);
        state.db = fake.db;
        const res = await put({ spokenText: "a" });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("turn_not_yours");
        fake.done();
    });

    it("answers 404 for a message that is not in the chat", async () => {
        const fake = scriptedDb([
            { table: "chats", data: chatRow },
            { table: "chat_messages", data: null },
        ]);
        state.db = fake.db;
        const res = await put({ spokenText: "a" });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ detail: "Message not found" });
        fake.done();
    });

    it("answers 404 for a user message", async () => {
        const fake = scriptedDb([
            { table: "chats", data: chatRow },
            { table: "chat_messages", data: { id: MESSAGE, role: "user", author_user_id: TEST_USER_ID } },
        ]);
        state.db = fake.db;
        expect((await put({ spokenText: "a" })).status).toBe(404);
        fake.done();
    });

    it("answers 404 for a message id that is not a UUID, without querying it", async () => {
        const fake = scriptedDb([{ table: "chats", data: chatRow }]);
        state.db = fake.db;
        expect((await put({ spokenText: "a" }, `/chat/${CHAT}/messages/not-a-uuid/spoken`)).status).toBe(404);
        fake.done();
    });

    it("never sends a database error to the client", async () => {
        const fake = scriptedDb([
            { table: "chats", data: chatRow },
            { table: "chat_messages", data: { id: MESSAGE, role: "assistant", author_user_id: TEST_USER_ID } },
            { table: "chat_messages", op: "update", error: { message: "relation secret_table does not exist" } },
        ]);
        state.db = fake.db;
        const res = await put({ spokenText: "a" });
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain("secret_table");
    });
});
