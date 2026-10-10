// Mission 6 acceptance (goals/mission-6-citation-verification-subagents.md):
// a drafted memo whose citations include a case the source contradicts, a
// fabricated case, a statute misquoted, a page that supports its use and a
// dead link. The model is scripted and sources come from scripted lookups, so
// nothing leaves the machine; the document is a real .docx read through the
// same reading text (with stable block ids) the assistant reads.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb } from "./memoryDb";
import { MEMO_PARAGRAPHS, SMITH_TEXT, fetchWeb, lookupCase, makeDocx, scriptedModel, searchWeb } from "./memoFixture";

const STORAGE_PATH = "documents/fixture/memo.docx";

const { state, llm } = vi.hoisted(() => ({
    state: {
        docx: null as Buffer | null,
        denied: new Set<string>(),
        enqueued: [] as unknown[],
        apiKeys: {} as Record<string, string>,
    },
    llm: { completeText: vi.fn() },
}));

vi.mock("../../../lib/storage", async (original) => ({
    ...(await original<typeof import("../../../lib/storage")>()),
    downloadFile: vi.fn(async (key: string) => {
        if (key !== STORAGE_PATH || !state.docx) return null;
        const bytes = state.docx;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }),
}));
vi.mock("../../documents/documents.service", async () => {
    const { DocxDocument } = await import("../../../lib/docx/view.js");
    return {
        getDocument: vi.fn(async (documentId: string) =>
            state.denied.has(documentId)
                ? { ok: false, kind: "not_found" }
                : { ok: true, doc: { id: documentId, project_id: "project-1", current_version_id: "version-1" } },
        ),
        docxViewForVersion: vi.fn(async (_db: unknown, _d: string, _v: string, bytes: Buffer) => DocxDocument.load(bytes)),
    };
});
vi.mock("../../user/user.service", () => ({
    getUserModelSettings: vi.fn(async () => ({ api_keys: state.apiKeys, last_selected_chat_model: "test-model" })),
}));
vi.mock("../../../lib/llm", async (original) => ({
    ...(await original<typeof import("../../../lib/llm")>()),
    completeText: llm.completeText,
}));
vi.mock("../../../lib/modelSelection", async (original) => ({
    ...(await original<typeof import("../../../lib/modelSelection")>()),
    resolveEffectiveChatModel: vi.fn(async () => ({ ok: true, model: "test-model", source: "request" })),
}));
vi.mock("../../../lib/dbq/enqueue", () => ({
    enqueueDbJob: vi.fn(async (_db: unknown, input: unknown) => {
        state.enqueued.push(input);
        return { id: randomUUID(), deduped: false };
    }),
}));

type Tasks = typeof import("../citations.tasks.js");
const loadTasks = async (): Promise<Tasks> => import("../citations.tasks.js");

const actor = { userId: "user-1", userEmail: "user@example.com" };
let store: MemoryDb;
let documentId: string;
let log: { extract: number; inFlight: number; maxInFlight: number };
let complete: ReturnType<typeof scriptedModel>;

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    state.denied.clear();
    state.enqueued.length = 0;
    state.apiKeys = {};
    state.docx = await makeDocx(MEMO_PARAGRAPHS);
    documentId = randomUUID();
    store = memoryDb({
        documents: [{ id: documentId, current_version_id: "version-1", project_id: "project-1" }],
        document_versions: [
            { id: "version-1", document_id: documentId, storage_path: STORAGE_PATH, file_type: "docx", filename: "memo.docx", deleted_at: null },
        ],
        projects: [{ id: "project-1", egress_policy: "allow" }],
        user_profiles: [{ user_id: "user-1", email: "user@example.com" }],
    });
    log = { extract: 0, inFlight: 0, maxInFlight: 0 };
    complete = scriptedModel(log);
});

async function startAndRun(tasks: Tasks, deps: Parameters<Tasks["runCitationCheck"]>[2] = {}) {
    const started = await tasks.startCitationCheck(store.db, { ...actor, documentId });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const run = await tasks.runCitationCheck(store.db, started.data.id, { complete, fetchWeb, searchWeb, lookupCase, ...deps });
    return { taskId: started.data.id, run };
}

function verdicts() {
    return [...store.tables.citation_checks]
        .sort((a, b) => (a.citation_ref as number) - (b.citation_ref as number))
        .map((row) => [row.citation_text, row.verdict]);
}

describe("document citation check", () => {
    it("finds each citation, checks it against its source and says what is wrong", async () => {
        const tasks = await loadTasks();
        const { taskId, run } = await startAndRun(tasks, { concurrency: 3 });
        expect(run).toEqual({ outcome: "completed" });
        expect(state.enqueued).toEqual([{ kind: "citations.verify", payload: { taskId }, dedupeKey: `citations.verify:${taskId}` }]);

        expect(verdicts()).toEqual([
            ["Smith v. Jones, 123 F.3d 456 (9th Cir. 1999)", "contradicted"],
            ["Doe v. Roe, 999 U.S. 1 (2031)", "not-found"],
            ["Records Act 2020, s. 4", "quote-mismatch"],
            ["Regulator guidance", "exists-and-matches"],
            ["Withdrawn note", "not-found"],
        ]);

        const rows = store.tables.citation_checks;
        const smith = rows.find((row) => row.citation_ref === 0)!;
        expect(smith).toMatchObject({
            source_kind: "case",
            support: "contradicts",
            excerpt: "the landlord owes a duty to repair the premises",
            proposition: "A landlord owes no duty to repair.",
        });
        expect(typeof smith.cited_block_id).toBe("string");
        const statute = rows.find((row) => row.citation_ref === 2)!;
        expect(statute).toMatchObject({ quote_found: false, support: "does-not-support" });
        expect(statute.reason).toMatch(/^The quoted words are not in the source\./);

        // Every source read is stored with its hash; every outbound request was audited first.
        const snapshots = store.tables.citation_snapshots;
        expect(snapshots.map((s) => s.source_kind).sort()).toEqual(["case", "web", "web"]);
        const audits = store.tables.audit_events.map((row) => (row.detail as { url: string }).url).sort();
        expect(audits).toEqual(
            [
                "https://example.org/guidance",
                "https://example.org/records-act-2020",
                "https://example.org/withdrawn",
                "https://www.courtlistener.com/",
                "https://www.courtlistener.com/",
                "web-search",
                "web-search",
            ].sort(),
        );

        // Checked in parallel.
        expect(log.maxInFlight).toBeGreaterThan(1);

        const summary = await tasks.summarizeCitationCheck(store.db, taskId);
        expect(summary.flagged.map((f) => f.verdict)).toEqual(["contradicted", "not-found", "quote-mismatch", "not-found"]);
    });

    it("resumes after a worker dies without listing the citations again", async () => {
        let tasks = await loadTasks();
        const started = await tasks.startCitationCheck(store.db, { ...actor, documentId });
        if (!started.ok) throw new Error("not started");
        await expect(
            tasks.runCitationCheck(store.db, started.data.id, {
                complete,
                fetchWeb,
                searchWeb,
                lookupCase,
                concurrency: 1,
                beforeStep: (citation) => {
                    if (citation.index === 2) throw new Error("worker process died");
                },
            }),
        ).rejects.toThrow("worker process died");
        expect(store.tables.citation_checks).toHaveLength(2);

        vi.resetModules();
        tasks = await loadTasks();
        expect(await tasks.runCitationCheck(store.db, started.data.id, { complete, fetchWeb, searchWeb, lookupCase })).toEqual({ outcome: "completed" });
        expect(log.extract).toBe(1);
        expect(store.tables.citation_checks).toHaveLength(5);
        expect(store.tables.verification_tasks[0]).toMatchObject({ status: "completed", steps_used: 5 });
    });

    it("re-checks a verdict from its stored snapshot", async () => {
        const tasks = await loadTasks();
        await startAndRun(tasks);
        for (const row of store.tables.citation_checks) {
            const recheck = await tasks.recheckCitation(store.db, { ...actor, checkId: row.id as string });
            if (!recheck.ok) throw new Error("recheck failed");
            if (row.snapshot_id) expect(recheck.data).toMatchObject({ same: true, hash_ok: true });
            else expect(recheck.data.same).toBe(false);
        }
        const statute = store.tables.citation_checks.find((row) => row.citation_ref === 2)!;
        const snapshot = store.tables.citation_snapshots.find((s) => s.id === statute.snapshot_id)!;
        snapshot.content = `${snapshot.content as string} Tampered.`;
        const tampered = await tasks.recheckCitation(store.db, { ...actor, checkId: statute.id as string });
        expect(tampered.ok && tampered.data).toMatchObject({ hash_ok: false, same: false });
    });

    it("makes no outbound request for a project that denies egress", async () => {
        store.tables.projects[0].egress_policy = "deny";
        const tasks = await loadTasks();
        await startAndRun(tasks);
        expect(fetchWeb).not.toHaveBeenCalled();
        expect(searchWeb).not.toHaveBeenCalled();
        expect(lookupCase).not.toHaveBeenCalled();
        expect(new Set(store.tables.citation_checks.map((row) => row.verdict))).toEqual(new Set(["unverifiable"]));
        expect(store.tables.audit_events ?? []).toHaveLength(0);
    });

    it("refuses someone who cannot read the document and stops when access is revoked", async () => {
        const tasks = await loadTasks();
        const started = await tasks.startCitationCheck(store.db, { ...actor, documentId });
        if (!started.ok) throw new Error("not started");
        state.denied.add(documentId);
        expect(await tasks.startCitationCheck(store.db, { ...actor, documentId })).toMatchObject({ ok: false, kind: "not_found" });
        expect(await tasks.runCitationCheck(store.db, started.data.id, { complete })).toMatchObject({ outcome: "failed", error: "access_revoked" });
        expect(complete).not.toHaveBeenCalled();
    });

    it("honours a cancellation between citations", async () => {
        const tasks = await loadTasks();
        const started = await tasks.startCitationCheck(store.db, { ...actor, documentId });
        if (!started.ok) throw new Error("not started");
        const run = await tasks.runCitationCheck(store.db, started.data.id, {
            complete,
            fetchWeb,
            searchWeb,
            lookupCase,
            concurrency: 1,
            beforeStep: async (citation) => {
                if (citation.index === 0) await tasks.cancelCitationCheck(store.db, { ...actor, taskId: started.data.id });
            },
        });
        expect(run).toEqual({ outcome: "cancelled" });
        expect(store.tables.citation_checks).toHaveLength(1);
    });
});

describe("judging support", () => {
    it("does not accept a judgement whose evidence is not in the source", async () => {
        const { judgeSupport } = await import("../citations.judge.js");
        const judge = vi.fn(async () =>
            JSON.stringify({ identified: true, support: "contradicts", reason: "Says the opposite.", evidence: "the landlord has no duty whatsoever" }),
        );
        const judgement = await judgeSupport(judge, {
            citation: { index: 0, blockId: null, context: "x", citation: "Smith", kind: "case", url: null, quote: null, proposition: "No duty." },
            source: SMITH_TEXT,
            sourceLabel: "opinion",
        });
        expect(judgement.support).toBe("unclear");
        expect(judgement.evidence).toBeNull();
    });

    it("sends a long source's most relevant passages, not its beginning", async () => {
        const { relevantPassages } = await import("../citations.judge.js");
        const filler = "Procedural history and unrelated discussion of venue. ".repeat(800);
        const source = `${filler} The covenant of quiet enjoyment is implied in every residential tenancy. ${filler}`;
        const passages = relevantPassages(source, "covenant quiet enjoyment implied residential tenancy", 4_000);
        expect(passages.length).toBeLessThanOrEqual(4_000 + 40);
        expect(passages).toContain("quiet enjoyment is implied");
    });
});

describe("checker model", () => {
    it("runs on the subscription flash models and hands over when one fails", async () => {
        state.apiKeys = { "opencode-go": "key" };
        const tasks = await loadTasks();
        const started = await tasks.startCitationCheck(store.db, { ...actor, documentId, model: "opencode-go/kimi-k3" });
        if (!started.ok) throw new Error("not started");
        expect(started.data.model).toBe("opencode-go/deepseek-v4.1-flash");

        const scripted = scriptedModel(log);
        llm.completeText.mockImplementation(async (args: { model: string; systemPrompt: string; user: string }) => {
            if (args.model === "opencode-go/deepseek-v4.1-flash") throw new Error("allowance used up");
            return scripted(args);
        });
        expect(await tasks.runCitationCheck(store.db, started.data.id, { fetchWeb, searchWeb, lookupCase })).toEqual({
            outcome: "completed",
        });
        const models = new Set(llm.completeText.mock.calls.map(([args]) => (args as { model: string }).model));
        expect(models).toEqual(new Set(["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"]));
        expect(store.tables.citation_checks).toHaveLength(5);
    });

    it("uses the person's model when they have no OpenCode Go key", async () => {
        const tasks = await loadTasks();
        const started = await tasks.startCitationCheck(store.db, { ...actor, documentId });
        expect(started.ok && started.data.model).toBe("test-model");
    });
});
