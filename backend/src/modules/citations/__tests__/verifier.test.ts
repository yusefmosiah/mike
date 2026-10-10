// Mission 6 acceptance (goals/mission-6-citation-verification-subagents.md):
// a fixture answer with a true local citation, an altered quote, a fabricated
// citation, a dead URL and a live URL whose text matches. The local document
// is a real public contract (fixtures/docx/public-legal); web pages come from
// a scripted fetcher, so nothing leaves the machine.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb } from "./memoryDb";

const FIXTURE = path.join(__dirname, "../../../__tests__/fixtures/docx/public-legal/uk-msc-core-terms-v2.2a.docx");
const STORAGE_PATH = "documents/fixture/core-terms.docx";

const { access, deniedDocuments, enqueued } = vi.hoisted(() => ({
    access: { chatReadable: true, projectId: null as string | null },
    deniedDocuments: new Set<string>(),
    enqueued: [] as Array<{ kind: string; payload: unknown }>,
}));

vi.mock("../../../lib/storage", async (original) => ({
    ...(await original<typeof import("../../../lib/storage")>()),
    downloadFile: vi.fn(async (key: string) => {
        if (key !== STORAGE_PATH) return null;
        const bytes = fs.readFileSync(FIXTURE);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }),
}));
vi.mock("../../documents/documents.service", async () => {
    const { DocxDocument } = await import("../../../lib/docx/view.js");
    return {
        getDocument: vi.fn(async (documentId: string) =>
            deniedDocuments.has(documentId) ? { ok: false, kind: "not_found" } : { ok: true, doc: { id: documentId } },
        ),
        docxViewForVersion: vi.fn(async (_db: unknown, _d: string, _v: string, bytes: Buffer) => DocxDocument.load(bytes)),
    };
});
vi.mock("../../chat/chat.service", async (original) => ({
    ...(await original<typeof import("../../chat/chat.service")>()),
    getAccessibleChat: vi.fn(async (_db: unknown, args: { chatId: string }) =>
        access.chatReadable
            ? { ok: true, chat: { id: args.chatId, project_id: access.projectId }, isCreator: true, projectRole: "owner" }
            : { ok: false },
    ),
}));
vi.mock("../../../lib/dbq/enqueue", () => ({
    enqueueDbJob: vi.fn(async (_db: unknown, input: { kind: string; payload: unknown }) => {
        enqueued.push(input);
        return { id: randomUUID(), deduped: false };
    }),
}));

type Tasks = typeof import("../citations.tasks.js");
const loadTasks = async (): Promise<Tasks> => import("../citations.tasks.js");

const TRUE_QUOTE =
    "it is validly incorporated, organised and subsisting in accordance with the Laws of its place of incorporation";
const ALTERED_QUOTE =
    "it is validly incorporated, organised and subsisting in accordance with the Laws of England and Wales";
const DEAD_URL = "https://example.org/judgments/withdrawn";
const LIVE_URL = "https://example.org/judgments/2026-ewca-civ-12";
const LIVE_TEXT = "Judgment. For these reasons the appeal is dismissed with costs. Lord Justice Example.";

const ids = {
    user: randomUUID(),
    chat: randomUUID(),
    message: randomUUID(),
    project: randomUUID(),
    document: randomUUID(),
    version: randomUUID(),
};

function citations() {
    return [
        {
            ref: 1,
            kind: "document",
            document: { document_id: ids.document, version_id: ids.version },
            quotes: [{ page: 1, quote: TRUE_QUOTE }, { page: 1, quote: ALTERED_QUOTE }],
        },
        {
            ref: 2,
            kind: "document",
            document: { document_id: randomUUID(), version_id: randomUUID() },
            quotes: [{ page: 4, quote: "The Supplier accepts unlimited liability for all losses." }],
        },
        { ref: 3, kind: "web", url: DEAD_URL, quotes: [{ quote: "The court allowed the appeal." }] },
        { ref: 4, kind: "web", url: LIVE_URL, quotes: [{ quote: "the appeal is dismissed with costs" }] },
    ];
}

function seed(egress: "allow" | "deny" = "allow"): MemoryDb {
    return memoryDb({
        user_profiles: [{ user_id: ids.user, email: "associate@example.com" }],
        projects: [{ id: ids.project, egress_policy: egress }],
        chat_messages: [{ id: ids.message, chat_id: ids.chat, role: "assistant", citations: citations() }],
        document_versions: [
            {
                id: ids.version,
                document_id: ids.document,
                storage_path: STORAGE_PATH,
                pdf_storage_path: null,
                file_type: "docx",
                filename: "uk-msc-core-terms-v2.2a.docx",
                deleted_at: null,
            },
        ],
    });
}

const fetchWeb = vi.fn(async (url: string) =>
    url === LIVE_URL
        ? { status: 200, text: LIVE_TEXT, finalUrl: url }
        : { status: 404, text: "Not Found", finalUrl: url },
);

async function checkedAnswer(memory: MemoryDb, tasks?: Tasks) {
    const module = tasks ?? (await loadTasks());
    const started = await module.startCitationCheck(memory.db, {
        userId: ids.user,
        userEmail: "associate@example.com",
        chatId: ids.chat,
        messageId: ids.message,
    });
    if (!started.ok) throw new Error(`not started: ${JSON.stringify(started)}`);
    return { module, task: started.data };
}

function verdicts(memory: MemoryDb) {
    return (memory.tables.citation_checks ?? [])
        .slice()
        .sort((a, b) => (a.citation_ref as number) - (b.citation_ref as number) || (a.quote_index as number) - (b.quote_index as number))
        .map((row) => [row.citation_ref, row.quote_index, row.verdict]);
}

beforeEach(() => {
    access.chatReadable = true;
    access.projectId = ids.project;
    deniedDocuments.clear();
    enqueued.length = 0;
    fetchWeb.mockClear();
});

describe("citation verifier", () => {
    it("grades each planted citation, telling a missing source from a misquoted one", async () => {
        const memory = seed();
        const { module, task } = await checkedAnswer(memory);
        expect(enqueued).toEqual([{ kind: "citations.verify", payload: { taskId: task.id }, dedupeKey: `citations.verify:${task.id}` }]);

        expect(await module.runCitationCheck(memory.db, task.id, { fetchWeb })).toEqual({ outcome: "completed" });
        expect(verdicts(memory)).toEqual([
            [1, 0, "exists-and-matches"],
            [1, 1, "quote-mismatch"],
            [2, 0, "not-found"],
            [3, 0, "not-found"],
            [4, 0, "exists-and-matches"],
        ]);

        const [trueLocal] = memory.tables.citation_checks.filter((row) => row.citation_ref === 1 && row.quote_index === 0);
        // Anchored to a stable block id of the cited version, with offsets into the snapshot.
        expect(trueLocal.block_id).toEqual(expect.any(String));
        expect(trueLocal.excerpt).toBe(TRUE_QUOTE);
        const snapshot = memory.tables.citation_snapshots.find((row) => row.id === trueLocal.snapshot_id)!;
        expect(snapshot).toMatchObject({ source_kind: "document", document_version_id: ids.version });
        const offsets = snapshot.block_offsets as Array<{ id: string; start: number; end: number }>;
        const block = offsets.find((entry) => entry.id === trueLocal.block_id)!;
        expect((snapshot.content as string).slice(block.start, block.end)).toContain(TRUE_QUOTE);

        // Both quotes of citation 1 were graded against one stored snapshot.
        const docSnapshots = memory.tables.citation_snapshots.filter((row) => row.source_kind === "document");
        expect(docSnapshots).toHaveLength(1);

        const misquote = memory.tables.citation_checks.find((row) => row.citation_ref === 1 && row.quote_index === 1)!;
        expect(misquote.snapshot_id).toBe(trueLocal.snapshot_id);
        const dead = memory.tables.citation_checks.find((row) => row.citation_ref === 3)!;
        expect(dead).toMatchObject({ snapshot_id: null, reason: "The page does not exist (HTTP 404)." });

        // One audit row per outbound fetch, written before it.
        const fetches = (memory.tables.audit_events ?? []).filter((row) => row.action === "egress.fetch");
        expect(fetches.map((row) => (row.detail as { url: string }).url).sort()).toEqual([LIVE_URL, DEAD_URL].sort());
        expect(fetchWeb).toHaveBeenCalledTimes(2);

        const task2 = memory.tables.verification_tasks[0];
        expect(task2).toMatchObject({ status: "completed", steps_used: 5, checkpoint: { next: 5 } });
    });

    it("counts a clause number the reader sees as part of the quoted text", async () => {
        // Found by the real-document probe: a model quoting "23.7.1 any
        // indirect ..." quotes what Word displays; the number is a list label,
        // not run text, and a snapshot without labels called it a misquote.
        const memory = seed();
        memory.tables.chat_messages[0].citations = [
            {
                ref: 1,
                kind: "document",
                document: { document_id: ids.document, version_id: ids.version },
                quotes: [{ quote: "23.7.1 any indirect, special or consequential Loss; and/or" }],
            },
        ];
        const { module, task } = await checkedAnswer(memory);
        await module.runCitationCheck(memory.db, task.id, { fetchWeb });
        expect(memory.tables.citation_checks[0]).toMatchObject({ verdict: "exists-and-matches", block_id: expect.any(String) });
    });

    it("reports a document the asker cannot read as unverifiable, never verified", async () => {
        const memory = seed();
        deniedDocuments.add(ids.document);
        const { module, task } = await checkedAnswer(memory);
        await module.runCitationCheck(memory.db, task.id, { fetchWeb });
        expect(verdicts(memory).filter(([ref]) => ref === 1)).toEqual([
            [1, 0, "unverifiable"],
            [1, 1, "unverifiable"],
        ]);
    });

    it("refuses an answer with nothing quoted, and a chat the asker cannot read", async () => {
        const module = await loadTasks();
        const memory = seed();
        memory.tables.chat_messages[0].citations = [{ ref: 1, kind: "document", document: {} }];
        expect(
            await module.startCitationCheck(memory.db, { userId: ids.user, userEmail: null, chatId: ids.chat, messageId: ids.message }),
        ).toMatchObject({ ok: false, kind: "validation", code: "no_citations" });
        access.chatReadable = false;
        expect(
            await module.startCitationCheck(memory.db, { userId: ids.user, userEmail: null, chatId: ids.chat, messageId: ids.message }),
        ).toMatchObject({ ok: false, kind: "not_found" });
    });

    it("stops at its step limit and honours a cancellation between steps", async () => {
        const memory = seed();
        const module = await loadTasks();
        const limited = await module.startCitationCheck(memory.db, {
            userId: ids.user, userEmail: null, chatId: ids.chat, messageId: ids.message, stepLimit: 2,
        });
        if (!limited.ok) throw new Error("not started");
        expect(await module.runCitationCheck(memory.db, limited.data.id, { fetchWeb })).toEqual({ outcome: "failed", error: "step_limit" });
        expect(memory.tables.citation_checks).toHaveLength(2);

        const second = await checkedAnswer(memory, module);
        const cancelled = await module.runCitationCheck(memory.db, second.task.id, {
            fetchWeb,
            beforeStep: async (index) => {
                if (index === 1) await module.cancelCitationCheck(memory.db, { userId: ids.user, userEmail: null, taskId: second.task.id });
            },
        });
        expect(cancelled).toEqual({ outcome: "cancelled" });
        expect(memory.tables.citation_checks.filter((row) => row.task_id === second.task.id)).toHaveLength(2);
    });
});

describe("citation verifier durable", () => {
    it("resumes after a process restart without regrading, and re-checks from the stored hash", async () => {
        const memory = seed();
        const first = await checkedAnswer(memory);
        // The worker dies before its fourth step.
        await expect(
            first.module.runCitationCheck(memory.db, first.task.id, {
                fetchWeb,
                beforeStep: (index) => {
                    if (index === 3) throw new Error("worker process died");
                },
            }),
        ).rejects.toThrow("worker process died");
        expect(memory.tables.verification_tasks[0]).toMatchObject({ status: "running", checkpoint: { next: 3 } });
        const before = memory.tables.citation_checks.map((row) => ({ ...row }));
        expect(before).toHaveLength(3);

        // A new process: fresh modules, the same database.
        vi.resetModules();
        const restarted = await loadTasks();
        expect(restarted).not.toBe(first.module);
        expect(await restarted.runCitationCheck(memory.db, first.task.id, { fetchWeb })).toEqual({ outcome: "completed" });
        expect(verdicts(memory).map(([, , verdict]) => verdict)).toEqual([
            "exists-and-matches", "quote-mismatch", "not-found", "not-found", "exists-and-matches",
        ]);
        for (const row of before) {
            expect(memory.tables.citation_checks.find((after) => after.id === row.id)).toEqual(row);
        }

        // A third person re-checks every verdict from its snapshot alone.
        const actor = { userId: randomUUID(), userEmail: "third@example.com" };
        for (const row of memory.tables.citation_checks) {
            const recheck = await restarted.recheckCitation(memory.db, { ...actor, checkId: row.id as string });
            if (!recheck.ok) throw new Error("recheck failed");
            if (row.snapshot_id) expect(recheck.data).toMatchObject({ same: true, hash_ok: true, verdict: row.verdict });
            else expect(recheck.data).toMatchObject({ verdict: null, stored_verdict: row.verdict });
        }

        // Altered evidence no longer passes as the same verdict.
        const live = memory.tables.citation_checks.find((row) => row.citation_ref === 4)!;
        const snapshot = memory.tables.citation_snapshots.find((row) => row.id === live.snapshot_id)!;
        snapshot.content = "Judgment. The appeal is allowed.";
        const tampered = await restarted.recheckCitation(memory.db, { ...actor, checkId: live.id as string });
        expect(tampered).toMatchObject({ ok: true, data: { hash_ok: false, same: false, verdict: "quote-mismatch" } });
    });

    it("refuses to grade a citation from inside the invocation that produced it", async () => {
        const memory = seed();
        const module = await loadTasks();
        const base = { userId: ids.user, userEmail: null, chatId: ids.chat, messageId: ids.message };
        expect(await module.startCitationCheck(memory.db, { ...base, invokedBy: ids.message })).toMatchObject({
            ok: false, kind: "conflict", code: "self_grading",
        });
        // Nor while the producing turn still holds the thread.
        memory.tables.chat_turn_claims = [
            { surface: "chat", chat_id: ids.chat, turn_id: ids.message, actor_user_id: ids.user, actor_role: "owner",
              claimed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() },
        ];
        expect(await module.startCitationCheck(memory.db, base)).toMatchObject({
            ok: false, kind: "conflict", code: "producer_running",
        });
        expect(memory.tables.verification_tasks ?? []).toHaveLength(0);
    });

    it("makes no outbound fetch for a project that denies egress, and calls web citations unverifiable", async () => {
        const memory = seed("deny");
        const { module, task } = await checkedAnswer(memory);
        await module.runCitationCheck(memory.db, task.id, { fetchWeb });
        expect(fetchWeb).not.toHaveBeenCalled();
        expect((memory.tables.audit_events ?? []).filter((row) => row.action === "egress.fetch")).toHaveLength(0);
        expect(verdicts(memory).filter(([ref]) => ref === 3 || ref === 4)).toEqual([
            [3, 0, "unverifiable"],
            [4, 0, "unverifiable"],
        ]);
        // Local documents are still checked: egress governs the web only.
        expect(verdicts(memory)[0]).toEqual([1, 0, "exists-and-matches"]);
    });
});
