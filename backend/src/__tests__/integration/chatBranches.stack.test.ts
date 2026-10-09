import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stackAuth, stackConfigured, stackDb } from "./stackDb";
import { createBranch, forkChat, setLeafAndPath } from "../../modules/chat/chat.branches";
import { getChatMessages } from "../../modules/chat/chat.messages";
import { linkedPrompt } from "../../modules/chat/chat.tree";
import type { Db } from "../../lib/db";

// Gated: runs only against a real Postgres + GoTrue (npm run test:stack,
// which starts both and sets DATABASE_TEST_URL, AUTH_TEST_URL and
// AUTH_TEST_SERVICE_KEY).
const maybeDescribe = stackConfigured ? describe : describe.skip;

maybeDescribe("chat branching against Postgres", () => {
    const db = stackDb() as unknown as Db;
    const admin = stackAuth();
    let userId = "";
    let userEmail = "";
    const chats: string[] = [];

    /** A chat with u1 → a1 → u2 → a2, timestamps one second apart. */
    async function seedChat() {
        const { data, error } = await db
            .from("chats")
            .insert({ user_id: userId, title: "Indemnity review" })
            .select("id")
            .single();
        if (error) throw error;
        const chatId = data.id as string;
        chats.push(chatId);
        const ids = {
            u1: crypto.randomUUID(),
            a1: crypto.randomUUID(),
            u2: crypto.randomUUID(),
            a2: crypto.randomUUID(),
        };
        const at = (s: number) => new Date(Date.UTC(2026, 9, 8, 12, 0, s)).toISOString();
        const rows = [
            { id: ids.u1, role: "user", content: "Review clause 7", parent_message_id: null, created_at: at(1) },
            { id: ids.a1, role: "assistant", content: [{ type: "content", text: "Clause 7 caps liability." }], parent_message_id: ids.u1, created_at: at(2) },
            { id: ids.u2, role: "user", content: "Is the cap mutual?", parent_message_id: ids.a1, created_at: at(3) },
            { id: ids.a2, role: "assistant", content: [{ type: "content", text: "Yes, it is mutual." }], parent_message_id: ids.u2, created_at: at(4) },
        ];
        for (const row of rows) {
            const { error: insertError } = await db
                .from("chat_messages")
                .insert({ ...row, chat_id: chatId, author_user_id: userId });
            if (insertError) throw insertError;
        }
        return { chatId, ids };
    }

    beforeAll(async () => {
        userEmail = `branches-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
        const created = await admin.admin.createUser({
            email: userEmail,
            password: "StackTest1!",
            email_confirm: true,
        });
        if (created.error || !created.data.user) throw created.error ?? new Error("no user");
        userId = created.data.user.id;
    });

    afterAll(async () => {
        if (chats.length) await db.from("chats").delete().in("id", chats);
        if (userId) await admin.admin.deleteUser(userId);
    });

    it("opening a prompt version shows its newest answer, not the bare prompt", async () => {
        const { chatId, ids } = await seedChat();
        const edited = await createBranch(db, { chatId, userId, fromMessageId: ids.u2, content: "Is the cap one-way?" });
        if (!edited.ok) throw new Error("branch failed");
        // The edited version has no answer yet: it is its own leaf.
        expect(edited.path.map((row) => row.id)).toEqual([ids.u1, ids.a1, edited.newMessageId]);

        // Stepping back to the original version lands on its answer.
        const back = await setLeafAndPath(db, { chatId, userId, leafId: ids.u2 });
        if (!back.ok) throw new Error("leaf move failed");
        expect(back.leaf).toBe(ids.a2);
        expect(back.path.map((row) => row.id)).toEqual([ids.u1, ids.a1, ids.u2, ids.a2]);

        // The transcript read follows the stored leaf.
        const transcript = await getChatMessages(db, chatId, userId);
        expect(transcript.messages.map((m) => m.id)).toEqual([ids.u1, ids.a1, ids.u2, ids.a2]);
        expect(transcript.siblings[ids.u2]).toEqual({ index: 1, total: 2 });

        // Opening the root lands on the newest message anywhere under it.
        const answer = crypto.randomUUID();
        await db.from("chat_messages").insert({
            id: answer,
            chat_id: chatId,
            role: "assistant",
            content: [{ type: "content", text: "No, only the supplier's." }],
            parent_message_id: edited.newMessageId,
            author_user_id: userId,
        });
        const root = await setLeafAndPath(db, { chatId, userId, leafId: ids.u1 });
        if (!root.ok) throw new Error("leaf move failed");
        expect(root.leaf).toBe(answer);
    });

    it("a re-answer reuses its named prompt wherever the reader's leaf is", async () => {
        const { chatId, ids } = await seedChat();
        expect(await linkedPrompt(db, chatId, ids.u2, "Is the cap mutual?")).toEqual({
            id: ids.u2,
            parentMessageId: ids.a1,
        });
        // Changed text is a new prompt; an answer is never a prompt.
        expect(await linkedPrompt(db, chatId, ids.u2, "Something else")).toBeNull();
        expect(await linkedPrompt(db, chatId, ids.a2, [{ type: "content", text: "Yes, it is mutual." }])).toBeNull();
    });

    it("branching into a new thread copies the path up to the answer into a new chat", async () => {
        const { chatId, ids } = await seedChat();
        const forked = await forkChat(db, {
            chatId,
            userId,
            userEmail,
            projectId: null,
            atMessageId: ids.a1,
        });
        if (!forked.ok) throw new Error(`fork failed: ${JSON.stringify(forked)}`);
        chats.push(forked.chatId);
        expect(forked.chatId).not.toBe(chatId);

        const copy = await getChatMessages(db, forked.chatId, userId);
        expect(copy.leaf).toBe(forked.leaf);
        expect(copy.messages.map((m) => [m.role, m.content])).toEqual([
            ["user", "Review clause 7"],
            ["assistant", [{ type: "content", text: "Clause 7 caps liability." }]],
        ]);
        expect(copy.messages.map((m) => m.id)).not.toContain(ids.u1);
        const { data: chat } = await db.from("chats").select("user_id, title, project_id").eq("id", forked.chatId).single();
        expect(chat).toEqual({ user_id: userId, title: "BRANCH Indemnity review", project_id: null });

        // The source chat is untouched.
        const source = await getChatMessages(db, chatId, userId);
        expect(source.messages.map((m) => m.id)).toEqual([ids.u1, ids.a1, ids.u2, ids.a2]);

        // Only an answer can be branched from.
        const fromPrompt = await forkChat(db, {
            chatId,
            userId,
            userEmail,
            projectId: null,
            atMessageId: ids.u2,
        });
        expect(fromPrompt).toMatchObject({ ok: false, kind: "validation" });
    });

    it("numbers a chat's branches in one sequence, branches of branches included", async () => {
        const { chatId, ids } = await seedChat();
        const fork = async (from: string, at: string) => {
            const forked = await forkChat(db, { chatId: from, userId, userEmail, projectId: null, atMessageId: at });
            if (!forked.ok) throw new Error(`fork failed: ${JSON.stringify(forked)}`);
            chats.push(forked.chatId);
            const { data } = await db.from("chats").select("title, branch_root_chat_id, branch_number").eq("id", forked.chatId).single();
            return { id: forked.chatId, leaf: forked.leaf, row: data };
        };

        const first = await fork(chatId, ids.a1);
        expect(first.row).toEqual({ title: "BRANCH Indemnity review", branch_root_chat_id: chatId, branch_number: 1 });

        const second = await fork(chatId, ids.a2);
        expect(second.row).toEqual({ title: "BRANCH 2 Indemnity review", branch_root_chat_id: chatId, branch_number: 2 });

        // A branch of a branch joins the same family, under the family's title.
        const nested = await fork(first.id, first.leaf);
        expect(nested.row).toEqual({ title: "BRANCH 3 Indemnity review", branch_root_chat_id: chatId, branch_number: 3 });

        // Deleting an older branch leaves a gap rather than a duplicate.
        await db.from("chats").delete().eq("id", second.id);
        const fourth = await fork(nested.id, nested.leaf);
        expect(fourth.row).toMatchObject({ title: "BRANCH 4 Indemnity review", branch_number: 4 });
    });
});
