import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stackAuth, stackConfigured, stackDb } from "./stackDb";
import type { Db } from "../../lib/db";

// Citation verification (goals/mission-6-citation-verification-subagents.md)
// against a real Postgres + GoTrue: the task, snapshot and verdict rows, their
// constraints, resuming after a restart, re-checking from the stored hash and
// the project egress policy. Web pages come from a scripted fetcher.
//
// Gated: runs only under npm run test:stack, which starts both services.
const maybeDescribe = stackConfigured ? describe : describe.skip;

type Citations = typeof import("../../modules/citations/citations.service.js");

const LIVE_URL = "https://example.org/judgments/2026-ewca-civ-12";
const DEAD_URL = "https://example.org/judgments/withdrawn";
const fetchWeb = vi.fn(async (url: string) =>
    url === LIVE_URL
        ? { status: 200, text: "For these reasons the appeal is dismissed with costs.", finalUrl: url }
        : { status: 404, text: "", finalUrl: url },
);

maybeDescribe("citation verification against Postgres", () => {
    const db = stackDb() as unknown as Db;
    const admin = stackAuth();
    let userId = "";
    let email = "";
    let projectId = "";
    let chatId = "";
    let messageId = "";

    async function load(): Promise<Citations> {
        vi.resetModules();
        return import("../../modules/citations/citations.service.js");
    }

    beforeAll(async () => {
        email = `citations-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
        const created = await admin.admin.createUser({ email, password: "StackTest1!", email_confirm: true });
        if (created.error || !created.data.user) throw created.error ?? new Error("no user");
        userId = created.data.user.id;
        await db.from("user_profiles").upsert({ user_id: userId, email }, { onConflict: "user_id" });
        const project = await db.from("projects").insert({ user_id: userId, name: "Citations" }).select("id").single();
        if (project.error) throw project.error;
        projectId = project.data.id as string;
        const chat = await db.from("chats").insert({ user_id: userId, title: "Cited answer", project_id: projectId }).select("id").single();
        if (chat.error) throw chat.error;
        chatId = chat.data.id as string;
        const prompt = await db.from("chat_messages").insert({ chat_id: chatId, role: "user", content: "Summarise.", author_user_id: userId }).select("id").single();
        if (prompt.error) throw prompt.error;
        const answer = await db
            .from("chat_messages")
            .insert({
                chat_id: chatId,
                role: "assistant",
                parent_message_id: prompt.data.id,
                content: [{ type: "content", text: "Answer [1][2][3]" }],
                citations: [
                    { ref: 1, kind: "web", url: LIVE_URL, quotes: [{ quote: "the appeal is dismissed with costs" }, { quote: "the appeal is allowed" }] },
                    { ref: 2, kind: "web", url: DEAD_URL, quotes: [{ quote: "anything at all" }] },
                    { ref: 3, kind: "document", document: { document_id: randomUUID(), version_id: randomUUID() }, quotes: [{ quote: "a clause that was never written" }] },
                ],
            })
            .select("id")
            .single();
        if (answer.error) throw answer.error;
        messageId = answer.data.id as string;
    });

    afterAll(async () => {
        if (chatId) await db.from("chats").delete().eq("id", chatId);
        if (projectId) await db.from("projects").delete().eq("id", projectId);
        await db.from("citation_snapshots").delete().in("url", [LIVE_URL, DEAD_URL]);
        if (userId) await admin.admin.deleteUser(userId);
    });

    it("stores verdicts and snapshots, resumes after a restart, and re-checks from the hash", async () => {
        const first = await load();
        const started = await first.startCitationCheck(db, { userId, userEmail: email, chatId, messageId });
        if (!started.ok) throw new Error(JSON.stringify(started));
        const taskId = started.data.id;
        const { data: job } = await db.from("db_jobs").select("kind, payload").eq("dedupe_key", `citations.verify:${taskId}`).maybeSingle();
        expect(job).toMatchObject({ kind: "citations.verify", payload: { taskId } });

        await expect(
            first.runCitationCheck(db, taskId, {
                fetchWeb,
                beforeStep: (index) => {
                    if (index === 2) throw new Error("worker process died");
                },
            }),
        ).rejects.toThrow("worker process died");

        const second = await load();
        expect(await second.runCitationCheck(db, taskId, { fetchWeb })).toEqual({ outcome: "completed" });
        const read = await second.getCitationChecks(db, { userId, userEmail: email, chatId, messageId });
        if (!read.ok) throw new Error("not read");
        expect(read.data.task).toMatchObject({ status: "completed", steps_used: 4, checkpoint: { next: 4 } });
        expect(read.data.checks.map((check) => [check.citation_ref, check.quote_index, check.verdict])).toEqual([
            [1, 0, "exists-and-matches"],
            [1, 1, "quote-mismatch"],
            [2, 0, "not-found"],
            [3, 0, "not-found"],
        ]);

        const { data: audits } = await db.from("audit_events").select("detail").eq("action", "egress.fetch").eq("chat_id", chatId);
        expect((audits as Array<{ detail: { url: string } }>).map((row) => row.detail.url).sort()).toEqual([DEAD_URL, LIVE_URL].sort());

        for (const check of read.data.checks) {
            const recheck = await second.recheckCitation(db, { userId, userEmail: email, checkId: check.id });
            if (!recheck.ok) throw new Error("recheck failed");
            if (check.snapshot_id) expect(recheck.data).toMatchObject({ same: true, hash_ok: true });
        }
    });

    it("refuses a self-graded task in the schema itself", async () => {
        const { error } = await db
            .from("verification_tasks")
            .insert({ id: messageId, chat_id: chatId, message_id: messageId, producer_invocation_id: messageId, actor_user_id: userId });
        expect(error).toBeTruthy();
    });

    it("makes no fetch for a project that denies egress", async () => {
        await db.from("projects").update({ egress_policy: "deny" }).eq("id", projectId);
        fetchWeb.mockClear();
        const citations = await load();
        const started = await citations.startCitationCheck(db, { userId, userEmail: email, chatId, messageId });
        if (!started.ok) throw new Error("not started");
        await citations.runCitationCheck(db, started.data.id, { fetchWeb });
        expect(fetchWeb).not.toHaveBeenCalled();
        const read = await citations.getCitationChecks(db, { userId, userEmail: email, chatId, messageId });
        if (!read.ok) throw new Error("not read");
        expect(read.data.checks.filter((check) => check.source_kind === "web").map((check) => check.verdict)).toEqual([
            "unverifiable",
            "unverifiable",
            "unverifiable",
        ]);
        const { error } = await db.from("projects").update({ egress_policy: "sometimes" }).eq("id", projectId);
        expect(error).toBeTruthy();
    });
});
