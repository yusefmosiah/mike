import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stackAuth, stackConfigured, stackDb } from "./stackDb";
import type { Db } from "../../lib/db";
import { chatTurnAuditEvents } from "../../lib/audit";

// Firm thread handoff (goals/mission-5-firm-thread-handoff.md) against a real
// Postgres + GoTrue: a partner starts a thread, an associate continues it, a
// third member reads it. "Two replicas" are two separately imported copies of
// the chat module, each with its own in-process turn registry, sharing one
// database: only the database claim can keep them to one turn.
//
// Gated: runs only under npm run test:stack, which starts both services.
const maybeDescribe = stackConfigured ? describe : describe.skip;

type ChatModule = typeof import("../../modules/chat/chat.service.js");

// One local model the senders choose; preparing a turn never calls it.
const MODEL_CONFIG = JSON.stringify({
    models: [{ id: "handoff-local", label: "Handoff local", provider: "openai-compatible", location: "local", baseUrl: "http://127.0.0.1:9/v1", apiModel: "handoff-local" }],
});

async function replica(): Promise<ChatModule> {
    vi.resetModules();
    return import("../../modules/chat/chat.service.js");
}

maybeDescribe("firm thread handoff against Postgres", () => {
    const db = stackDb() as unknown as Db;
    const admin = stackAuth();
    const people: Record<"partner" | "associate" | "third", { id: string; email: string }> = {
        partner: { id: "", email: "" },
        associate: { id: "", email: "" },
        third: { id: "", email: "" },
    };
    let chatId = "";
    let replicaA: ChatModule;
    let replicaB: ChatModule;

    const send = (module: ChatModule, who: keyof typeof people, text: string, turnId = randomUUID()) =>
        module.prepareChatStream(db, {
            userId: people[who].id,
            userEmail: people[who].email,
            messages: [{ role: "user", content: text }],
            chatId,
            inputMessageId: randomUUID(),
            projectIdProvided: false,
            projectId: null,
            askInputsResponse: null,
            requestedModel: "handoff-local",
            requestedReasoning: undefined,
            turnId,
        });

    async function prompts(): Promise<Array<{ content: unknown; author_user_id: string }>> {
        const { data, error } = await db
            .from("chat_messages")
            .select("content, author_user_id")
            .eq("chat_id", chatId)
            .eq("role", "user");
        if (error) throw error;
        return data as Array<{ content: unknown; author_user_id: string }>;
    }

    async function grant(who: "associate" | "third", role: "editor" | "viewer") {
        const { error } = await db
            .from("chat_access_grants")
            .upsert({ chat_id: chatId, email: people[who].email, role, created_by: people.partner.id }, { onConflict: "chat_id,email" });
        if (error) throw error;
    }

    beforeAll(async () => {
        const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        for (const who of Object.keys(people) as Array<keyof typeof people>) {
            const email = `handoff-${who}-${stamp}@example.com`;
            const created = await admin.admin.createUser({ email, password: "StackTest1!", email_confirm: true });
            if (created.error || !created.data.user) throw created.error ?? new Error("no user");
            people[who] = { id: created.data.user.id, email };
            await db.from("user_profiles").upsert({ user_id: created.data.user.id, email, display_name: `The ${who}` }, { onConflict: "user_id" });
        }
        const { data, error } = await db
            .from("chats")
            .insert({ user_id: people.partner.id, title: "Matter 2291: indemnity" })
            .select("id")
            .single();
        if (error) throw error;
        chatId = data.id as string;
        await grant("associate", "editor");
        await grant("third", "viewer");
        process.env.MIKE_MODEL_CONFIG_JSON = MODEL_CONFIG;
        replicaA = await replica();
        replicaB = await replica();
        expect(replicaA).not.toBe(replicaB);
    });

    afterAll(async () => {
        delete process.env.MIKE_MODEL_CONFIG_JSON;
        if (chatId) await db.from("chats").delete().eq("id", chatId);
        for (const person of Object.values(people)) if (person.id) await admin.admin.deleteUser(person.id);
    });

    it("lets one of two concurrent senders on different replicas through, and writes only that prompt", async () => {
        const [partnerTry, associateTry] = await Promise.all([
            send(replicaA, "partner", "Summarise the indemnity cap."),
            send(replicaB, "associate", "Which clause caps liability?"),
        ]);
        const outcomes = [partnerTry, associateTry];
        const admitted = outcomes.filter((outcome) => outcome.ok);
        const refused = outcomes.filter((outcome) => !outcome.ok);
        expect(admitted).toHaveLength(1);
        expect(refused).toHaveLength(1);
        const winner = partnerTry.ok ? "partner" : "associate";
        expect(refused[0]).toMatchObject({
            status: 409,
            code: "turn_in_progress",
            generating: { user_id: people[winner].id },
        });
        const stored = await prompts();
        expect(stored).toHaveLength(1);
        expect(stored[0].author_user_id).toBe(people[winner].id);

        // Every reader sees who is generating, whichever replica they ask.
        const presence = await replicaB.threadPresence(db, chatId, []);
        expect(presence.generating?.user_id).toBe(people[winner].id);

        // The turn ends; the other person carries the thread on.
        if (!admitted[0].ok) throw new Error("unreachable");
        expect(admitted[0].prepared.actorRole).toBe(winner === "partner" ? "owner" : "editor");
        await admitted[0].prepared.turnClaim?.release();
        const loser = winner === "partner" ? "associate" : "partner";
        const next = await send(winner === "partner" ? replicaB : replicaA, loser, "Continue from there.");
        expect(next.ok).toBe(true);
        if (next.ok) await next.prepared.turnClaim?.release();

        const authors = new Set((await prompts()).map((prompt) => prompt.author_user_id));
        expect(authors).toEqual(new Set([people.partner.id, people.associate.id]));
        const transcript = await replicaA.getChatMessages(db, chatId, people.third.id);
        const read = await replicaA.threadPresence(db, chatId, transcript.messages);
        expect(read.authors[people.partner.id]).toEqual({ name: "The partner", email: people.partner.email });
        expect(read.authors[people.associate.id]).toEqual({ name: "The associate", email: people.associate.email });
        expect(read.generating).toBeNull();
    });

    it("refuses a viewer with an intentional 403 and writes nothing", async () => {
        const before = (await prompts()).length;
        const viewer = await send(replicaA, "third", "Can I add something?");
        expect(viewer).toMatchObject({ ok: false, status: 403 });
        expect((await prompts()).length).toBe(before);
    });

    it("applies a grant change on the next request, with no restart", async () => {
        await grant("third", "editor");
        const promoted = await send(replicaB, "third", "Now I can write.");
        expect(promoted.ok).toBe(true);
        if (promoted.ok) await promoted.prepared.turnClaim?.release();

        const { error } = await db.from("chat_access_grants").delete().eq("chat_id", chatId).eq("email", people.third.email);
        if (error) throw error;
        const revoked = await send(replicaB, "third", "And now?");
        expect(revoked).toMatchObject({ ok: false });
        expect(revoked.ok ? 0 : "status" in revoked ? revoked.status : 0).toBe(404);
        await grant("third", "viewer");
    });

    it("frees a thread whose holder died: the lease lapses", async () => {
        const held = await send(replicaA, "partner", "A turn whose process will die.");
        if (!held.ok) throw new Error("not admitted");
        // The process dies: no release, no renewal. Age the lease out.
        await db.from("chat_turn_claims").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("chat_id", chatId);
        const after = await send(replicaB, "associate", "Picking it up.");
        expect(after.ok).toBe(true);
        if (after.ok) await after.prepared.turnClaim?.release();
        // The dead turn's late release must not free the new holder's claim.
        await held.prepared.turnClaim?.release();
    });

    it("lets a restarted process resume its own turn", async () => {
        const turnId = randomUUID();
        const first = await send(replicaA, "partner", "Resume me.", turnId);
        if (!first.ok) throw new Error("not admitted");
        // Same turn, other process: the claim is re-granted, not refused.
        const resumed = await send(replicaB, "partner", "Resume me.", turnId);
        expect(resumed.ok).toBe(true);
        if (resumed.ok) await resumed.prepared.turnClaim?.release();
    });

    it("records the actor's role on the turn's audit row", () => {
        const [row] = chatTurnAuditEvents(
            { userId: people.associate.id, chatId, model: "m", flags: { actor_role: "editor" } },
            [],
        );
        expect(row).toMatchObject({ userId: people.associate.id, action: "chat.message", detail: { actor_role: "editor" } });
    });

    it("stamps who created a document version", async () => {
        const { createDocumentVersion } = await import("../../modules/documents/documents.service.js");
        const { data: doc, error } = await db
            .from("documents")
            .insert({ user_id: people.associate.id })
            .select("id")
            .single();
        if (error) throw error;
        try {
            const created = await createDocumentVersion(db, {
                document_id: doc.id as string,
                storage_path: `documents/${people.associate.id}/${doc.id}/nda.docx`,
                source: "upload",
                filename: "nda.docx",
                created_by: people.associate.id,
            });
            expect(created.error).toBeNull();
            expect((created.data as { created_by?: string } | null)?.created_by).toBe(people.associate.id);
        } finally {
            await db.from("documents").delete().eq("id", doc.id);
        }
    });

    it("runs a guest's turn in the starter's workstation, and asks the starter before a guest's command", async () => {
        const turn = await send(replicaA, "associate", "Run the numbers in Python.");
        expect(turn.ok).toBe(true);
        if (!turn.ok) return;
        await turn.prepared.turnClaim?.release();
        // The thread's code runs in the partner's VM whoever sends.
        expect(turn.prepared.workstationUserId).toBe(people.partner.id);

        const guest = await replicaA.guestCodeApprovalFor(db, { chatId, hostUserId: people.partner.id, guestUserId: people.associate.id });
        expect(guest).toMatchObject({ hostName: "The partner", standing: false });
        expect(await replicaA.guestCodeApprovalFor(db, { chatId, hostUserId: people.partner.id, guestUserId: people.partner.id })).toBeNull();

        // A command waits; only the partner sees the request.
        const waiting = guest!.request("python3 totals.py");
        let pending: Awaited<ReturnType<ChatModule["codeApprovalsForViewer"]>> = [];
        for (let i = 0; i < 20 && !pending.length; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            pending = await replicaB.codeApprovalsForViewer(db, chatId, people.partner.id);
        }
        expect(pending).toMatchObject([{ guest_user_id: people.associate.id, guest_name: "The associate", summary: "python3 totals.py", status: "pending" }]);
        expect(await replicaB.codeApprovalsForViewer(db, chatId, people.associate.id)).toEqual([]);

        // The guest cannot answer their own request; the partner can, once.
        const selfApproved = await replicaB.decideCodeApproval(db, { chatId, requestId: pending[0].id, hostUserId: people.associate.id, decision: "thread" });
        expect(selfApproved).toMatchObject({ ok: false, kind: "conflict" });
        expect(await replicaB.decideCodeApproval(db, { chatId, requestId: pending[0].id, hostUserId: people.partner.id, decision: "thread" })).toEqual({ ok: true, data: { status: "thread" } });
        expect(await waiting).toBe("thread");
        expect(await replicaB.decideCodeApproval(db, { chatId, requestId: pending[0].id, hostUserId: people.partner.id, decision: "denied" })).toMatchObject({ ok: false, kind: "conflict" });

        // Allowed for this thread: the next turn starts allowed, and the
        // partner sees whom they allowed.
        expect((await replicaA.guestCodeApprovalFor(db, { chatId, hostUserId: people.partner.id, guestUserId: people.associate.id }))?.standing).toBe(true);
        expect(await replicaB.codeApprovalsForViewer(db, chatId, people.partner.id)).toMatchObject([{ guest_user_id: people.associate.id, status: "thread" }]);

        // It does not reach another thread the partner starts.
        const { data: other, error } = await db.from("chats").insert({ user_id: people.partner.id, title: "Matter 2292" }).select("id").single();
        if (error) throw error;
        try {
            expect((await replicaA.guestCodeApprovalFor(db, { chatId: other.id as string, hostUserId: people.partner.id, guestUserId: people.associate.id }))?.standing).toBe(false);
        } finally {
            await db.from("chats").delete().eq("id", other.id);
        }

        // Withdrawn, the guest is asked again; an unanswered request expires.
        expect(await replicaB.revokeThreadCodeApproval(db, { chatId, hostUserId: people.partner.id, guestUserId: people.associate.id })).toEqual({ ok: true, data: { revoked: 1 } });
        expect((await replicaA.guestCodeApprovalFor(db, { chatId, hostUserId: people.partner.id, guestUserId: people.associate.id }))?.standing).toBe(false);
        const { requestCodeApproval } = await import("../../modules/chat/chat.codeApprovals.js");
        expect(await requestCodeApproval(db, { chatId, hostUserId: people.partner.id, guestUserId: people.associate.id, summary: "ls", timeoutMs: 300, pollMs: 50 })).toBe("expired");
        expect(await replicaB.codeApprovalsForViewer(db, chatId, people.partner.id)).toEqual([]);
    });
});
