import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stackAuth, stackConfigured, stackDb } from "./stackDb";
import type { Db } from "../../lib/db";

// Document citation checks (goals/mission-6-citation-verification-subagents.md)
// against a real Postgres + GoTrue: the task, snapshot and verdict rows, their
// constraints, real document access checks, resuming after a restart,
// re-checking from the stored hash and the project egress policy. The model
// and the sources are scripted (memoFixture); the document's bytes come from
// a stubbed store.
//
// Gated: runs only under npm run test:stack, which starts both services.
const maybeDescribe = stackConfigured ? describe : describe.skip;

const { docx } = vi.hoisted(() => ({ docx: { bytes: null as Buffer | null } }));
vi.mock("../../lib/storage", async (original) => ({
    ...(await original<typeof import("../../lib/storage")>()),
    downloadFile: vi.fn(async () => {
        const bytes = docx.bytes;
        return bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : null;
    }),
}));

type Citations = typeof import("../../modules/citations/citations.service.js");
type Fixture = typeof import("../../modules/citations/__tests__/memoFixture.js");

maybeDescribe("document citation checks against Postgres", () => {
    const db = stackDb() as unknown as Db;
    const admin = stackAuth();
    let fixture: Fixture;
    let userId = "";
    let email = "";
    let projectId = "";
    let documentId = "";

    async function load(): Promise<Citations> {
        vi.resetModules();
        return import("../../modules/citations/citations.service.js");
    }
    const deps = (log = { extract: 0, inFlight: 0, maxInFlight: 0 }) => ({
        complete: fixture.scriptedModel(log),
        fetchWeb: fixture.fetchWeb,
        searchWeb: fixture.searchWeb,
        lookupCase: fixture.lookupCase,
    });

    beforeAll(async () => {
        fixture = await import("../../modules/citations/__tests__/memoFixture.js");
        docx.bytes = await fixture.makeDocx(fixture.MEMO_PARAGRAPHS);
        email = `citations-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
        const created = await admin.admin.createUser({ email, password: "StackTest1!", email_confirm: true });
        if (created.error || !created.data.user) throw created.error ?? new Error("no user");
        userId = created.data.user.id;
        await db.from("user_profiles").upsert({ user_id: userId, email, last_selected_chat_model: "gemini-3-flash-preview" }, { onConflict: "user_id" });
        const project = await db.from("projects").insert({ user_id: userId, name: "Citations" }).select("id").single();
        if (project.error) throw project.error;
        projectId = project.data.id as string;
        const doc = await db.from("documents").insert({ user_id: userId, project_id: projectId, status: "ready" }).select("id").single();
        if (doc.error) throw doc.error;
        documentId = doc.data.id as string;
        const version = await db
            .from("document_versions")
            .insert({ document_id: documentId, storage_path: `documents/${documentId}/memo.docx`, source: "assistant_edit", version_number: 1, filename: "memo.docx", file_type: "docx" })
            .select("id")
            .single();
        if (version.error) throw version.error;
        await db.from("documents").update({ current_version_id: version.data.id }).eq("id", documentId);
        process.env.CITATION_CHECK_MODEL = "gemini-3-flash-preview";
        process.env.GEMINI_API_KEY ??= "stack-test-key";
    });

    afterAll(async () => {
        delete process.env.CITATION_CHECK_MODEL;
        if (documentId) await db.from("documents").delete().eq("id", documentId);
        if (projectId) await db.from("projects").delete().eq("id", projectId);
        await db.from("citation_snapshots").delete().in("url", ["https://example.org/guidance", "https://example.org/records-act-2020", "https://www.courtlistener.com/opinion/1/smith-v-jones/"]);
        if (userId) await admin.admin.deleteUser(userId);
    });

    it("stores verdicts and snapshots, resumes after a restart, and re-checks from the hash", async () => {
        const first = await load();
        const started = await first.startCitationCheck(db, { userId, userEmail: email, documentId });
        if (!started.ok) throw new Error(JSON.stringify(started));
        const taskId = started.data.id;
        const { data: job } = await db.from("db_jobs").select("kind, payload").eq("dedupe_key", `citations.verify:${taskId}`).maybeSingle();
        expect(job).toMatchObject({ kind: "citations.verify", payload: { taskId } });

        await expect(
            first.runCitationCheck(db, taskId, {
                ...deps(),
                concurrency: 1,
                beforeStep: (citation) => {
                    if (citation.index === 2) throw new Error("worker process died");
                },
            }),
        ).rejects.toThrow("worker process died");

        const second = await load();
        expect(await second.runCitationCheck(db, taskId, { ...deps(), concurrency: 3 })).toEqual({ outcome: "completed" });
        const read = await second.getCitationChecks(db, { userId, userEmail: email, documentId });
        if (!read.ok) throw new Error("not read");
        expect(read.data.task).toMatchObject({ status: "completed", steps_used: 5, kind: "document_citation_check" });
        expect(read.data.checks.map((check) => [check.citation_text, check.verdict])).toEqual(fixture.MEMO_VERDICTS);

        const { data: audits } = await db.from("audit_events").select("detail").eq("action", "egress.fetch").eq("document_id", documentId);
        expect((audits as unknown[]).length).toBeGreaterThanOrEqual(5);

        for (const check of read.data.checks) {
            const recheck = await second.recheckCitation(db, { userId, userEmail: email, checkId: check.id });
            if (!recheck.ok) throw new Error("recheck failed");
            if (check.snapshot_id) expect(recheck.data).toMatchObject({ same: true, hash_ok: true });
        }
    });

    it("refuses a document task without a version, and an unknown verdict, in the schema itself", async () => {
        const task = await db.from("verification_tasks").insert({ kind: "document_citation_check", document_id: documentId, actor_user_id: userId });
        expect(task.error).toBeTruthy();
        const { data: anyTask } = await db.from("verification_tasks").select("id").eq("document_id", documentId).limit(1);
        const check = await db.from("citation_checks").insert({
            task_id: (anyTask as Array<{ id: string }>)[0].id,
            document_id: documentId,
            citation_ref: 99,
            quote_index: 0,
            source_kind: "web",
            verdict: "probably-fine",
        });
        expect(check.error).toBeTruthy();
    });

    it("makes no outbound request for a project that denies egress", async () => {
        await db.from("projects").update({ egress_policy: "deny" }).eq("id", projectId);
        fixture.fetchWeb.mockClear();
        fixture.searchWeb.mockClear();
        fixture.lookupCase.mockClear();
        const citations = await load();
        const started = await citations.startCitationCheck(db, { userId, userEmail: email, documentId });
        if (!started.ok) throw new Error("not started");
        await citations.runCitationCheck(db, started.data.id, deps());
        expect(fixture.fetchWeb).not.toHaveBeenCalled();
        expect(fixture.searchWeb).not.toHaveBeenCalled();
        expect(fixture.lookupCase).not.toHaveBeenCalled();
        const read = await citations.getCitationChecks(db, { userId, userEmail: email, documentId });
        if (!read.ok) throw new Error("not read");
        expect(new Set(read.data.checks.map((check) => check.verdict))).toEqual(new Set(["unverifiable"]));
    });
});
