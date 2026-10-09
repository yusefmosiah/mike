// Unit tests for the rlm.deep_run job handler.
//
// The handler is exercised end to end against a scripted database stand-in and
// injected model/sandbox services, so the tests pin the run's invariants:
//   * unattended — the wave calls advertise exactly the sandbox tool, never a
//     pause/ask surface;
//   * copy-on-write — reads plus one memo document, with compensation when the
//     memo cannot be persisted;
//   * bounded — waves and document reads respect max_waves / max_docs;
//   * idempotent — a retry whose memo already exists makes no model call.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DbJob } from "../../../lib/dbq/types";
import type { ProjectAccess } from "../../../lib/access";
import type { Db } from "../../../lib/db";
import { contentSha256 } from "../../../lib/documentVersions";

const storage = vi.hoisted(() => ({
    downloadFile: vi.fn(),
    uploadFile: vi.fn(),
    storageKey: vi.fn(
        (userId: string, docId: string, filename: string) =>
            `documents/${userId}/${docId}/source.${filename.split(".").pop() ?? "bin"}`,
    ),
}));
// The run owner's email comes from GoTrue, through authAdmin().
vi.mock("../../../lib/gotrue", () => ({
    authAdmin: () => ({
        admin: {
            getUserById: async (_id: string) => ({
                data: { user: { email: "owner@example.com" } },
                error: null,
            }),
        },
    }),
}));

vi.mock("../../../lib/storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../lib/storage")>();
    return {
        ...actual,
        downloadFile: (...args: unknown[]) => storage.downloadFile(...args),
        uploadFile: (...args: unknown[]) => storage.uploadFile(...args),
        storageKey: (...args: Parameters<typeof storage.storageKey>) => storage.storageKey(...args),
    };
});

import {
    handleRlmDeepRun,
    DEFAULT_RLM_MODEL,
    RLM_DEEP_RUN_KIND,
    RLM_EXECUTE_CODE_TOOL,
    type RlmRunServices,
} from "../diligence.rlm";
import { parseRlmRunBody } from "../diligence.service";

const JOB_ID = "11111111-1111-4111-8111-111111111111";

type QueryResult = { data?: unknown; error?: unknown };

type RecordedCall = {
    table: string;
    op: string;
    payload?: unknown;
    filters: Array<[string, ...unknown[]]>;
};

/** Minimal database stand-in: per-table result queues, every settled call
 *  recorded so tests can assert scope, payloads, and filter order. */
function makeFakeDb(spec: {
    tables?: Record<string, QueryResult[]>;
    rpc?: (fn: string, args: Record<string, unknown>) => QueryResult;
}) {
    const calls: RecordedCall[] = [];
    const cursors: Record<string, number> = {};
    const resultFor = (table: string): QueryResult => {
        const seeded = spec.tables?.[table];
        if (!seeded || seeded.length === 0) return { data: null, error: null };
        const index = cursors[table] ?? 0;
        cursors[table] = index + 1;
        return seeded[Math.min(index, seeded.length - 1)];
    };
    const from = (table: string) => {
        const state: RecordedCall = { table, op: "select", filters: [] };
        const settle = () => {
            calls.push({
                ...state,
                filters: state.filters.map((f) => [...f] as [string, ...unknown[]]),
            });
            return Promise.resolve(resultFor(table));
        };
        const builder: Record<string, unknown> = {
            select: () => builder,
            single: () => settle(),
            maybeSingle: () => settle(),
            then: (
                onFulfilled?: (value: QueryResult) => unknown,
                onRejected?: (reason: unknown) => unknown,
            ) => settle().then(onFulfilled, onRejected),
        };
        for (const op of ["insert", "upsert", "update", "delete"]) {
            builder[op] = (payload?: unknown) => {
                state.op = op;
                state.payload = payload;
                return builder;
            };
        }
        for (const filter of ["eq", "is", "in", "or", "order", "range", "limit", "not", "lt"]) {
            builder[filter] = (...args: unknown[]) => {
                state.filters.push([filter, ...args]);
                return builder;
            };
        }
        return builder;
    };
    const rpc = (fn: string, args: Record<string, unknown>) => {
        calls.push({ table: fn, op: "rpc", payload: args, filters: [] });
        return Promise.resolve(spec.rpc?.(fn, args) ?? { data: null, error: null });
    };
    const db = { from, rpc } as unknown as Db;
    return { db, calls };
}

const textBuffer = (text: string): ArrayBuffer =>
    new TextEncoder().encode(text).buffer as ArrayBuffer;

const docRow = (id: string, folderId: string | null = null) => ({
    id,
    current_version_id: `v-${id}`,
    folder_id: folderId,
});

const attachRow = (docId: string, overrides: Record<string, unknown> = {}) => ({
    id: `v-${docId}`,
    storage_path: `documents/u1/${docId}/source.md`,
    pdf_storage_path: null,
    version_number: 1,
    filename: `${docId}.md`,
    source: "upload",
    file_type: "md",
    size_bytes: 5,
    page_count: null,
    content_sha256: "sha",
    ...overrides,
});

const baseJob = (payload: Record<string, unknown> = {}): DbJob => ({
    id: JOB_ID,
    kind: RLM_DEEP_RUN_KIND,
    payload: {
        projectId: "p1",
        userId: "u1",
        prompt: "Compare the two loan offers",
        ...payload,
    },
    status: "running",
    attempts: 1,
    max_attempts: 3,
    run_at: "2026-10-07T12:00:00.000Z",
    claimed_at: null,
    finished_at: null,
    last_error: null,
    dedupe_key: null,
    result: null,
    created_at: "2026-10-07T12:00:00.000Z",
});

const ALLOW_ACCESS: ProjectAccess = {
    ok: true,
    isCreator: true,
    orgRole: null,
    projectRole: "owner",
    project: { id: "p1", user_id: "u1", org_id: "org-1" },
};

type ToolCallInput = { id: string; name: string; input: Record<string, unknown> };
type ToolCallResult = { tool_use_id: string; content: string };

type StreamCall = {
    model: string;
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
    tools?: unknown[];
    runTools?: (calls: ToolCallInput[]) => Promise<ToolCallResult[]>;
    maxIterations?: number;
    conversationId?: string;
};

/** A typed stream recorder: replies are served in order (last one repeats),
 *  and every params object is captured with its real shape. */
function makeStream(replies: string[]) {
    const calls: StreamCall[] = [];
    const fn = vi.fn(async (params: StreamCall) => {
        calls.push(params);
        return { fullText: replies[Math.min(calls.length - 1, replies.length - 1)] ?? "" };
    });
    return { calls, fn, service: fn as unknown as RlmRunServices["stream"] };
}

function makeExecuteCode() {
    const fn = vi.fn(
        async (_args: { code: string; timeoutMs?: number; maxOutputChars?: number }) => ({
            ok: true as const,
            output: "42",
            truncated: false,
        }),
    );
    return { fn, service: fn as unknown as RlmRunServices["executeCode"] };
}

function makeCheckProject(access: ProjectAccess) {
    const fn = vi.fn(async () => access);
    return { fn, service: fn as unknown as RlmRunServices["checkProject"] };
}

type ExecuteCodeArgs = { code: string; timeoutMs?: number; maxOutputChars?: number };

function makeServices(overrides: Partial<RlmRunServices> = {}): RlmRunServices {
    const executeCode = vi.fn(async (_args: ExecuteCodeArgs) => ({
        ok: true as const,
        output: "42",
        truncated: false,
    }));
    return {
        stream: (async () => ({
            fullText: "## Findings\n- fee is 1.2% [d1.md]",
        })) as unknown as RlmRunServices["stream"],
        executeCode: executeCode as unknown as RlmRunServices["executeCode"],
        checkProject: (async () => ALLOW_ACCESS) as unknown as RlmRunServices["checkProject"],
        ...overrides,
    };
}

const uploads: Array<{ path: string; bytes: ArrayBuffer; contentType: string }> = [];

beforeEach(() => {
    vi.clearAllMocks();
    // The enqueue path must never reach for a real Redis producer: pin the
    // DB poller transport regardless of the developer's environment.
    vi.stubEnv("QUEUE_DRIVER", "postgres");
    uploads.length = 0;
    storage.uploadFile
        .mockReset()
        .mockImplementation(async (path: string, bytes: ArrayBuffer, contentType: string) => {
            uploads.push({ path, bytes, contentType });
        });
    storage.downloadFile.mockReset().mockResolvedValue(textBuffer("hello world"));
});

afterEach(() => vi.unstubAllEnvs());

describe("handleRlmDeepRun", () => {
    it("pins the registered job kind", () => {
        expect(RLM_DEEP_RUN_KIND).toBe("rlm.deep_run");
    });

    it("writes exactly one memo document and advertises only execute_code", async () => {
        const { db, calls } = makeFakeDb({
            tables: {
                document_versions: [
                    { data: null }, // idempotency guard
                    { data: [attachRow("d1")] }, // attachActiveVersionPaths
                ],
                documents: [
                    { data: [docRow("d1")] }, // scope list
                    { data: null }, // upsert row
                    { data: null }, // status -> ready
                ],
            },
            rpc: (fn, args) => {
                if (fn !== "create_document_version") {
                    return { data: null, error: { message: `unexpected rpc ${fn}` } };
                }
                // The handler always sends p_version as a plain object; echo it.
                const version = args.p_version as { id?: string; storage_path?: string };
                return {
                    data: {
                        id: version.id,
                        document_id: args.p_document_id,
                        storage_path: version.storage_path,
                        version_number: 1,
                    },
                    error: null,
                };
            },
        });
        const stream = makeStream(["## Findings\n- fee is 1.2% [d1.md]", "# Memo\nbody"]);
        const executeCode = makeExecuteCode();
        const services = makeServices({
            stream: stream.service,
            executeCode: executeCode.service,
        });

        const result = await handleRlmDeepRun(db, baseJob(), services);

        expect(result).toMatchObject({
            outcome: "completed",
            memoDocumentId: JOB_ID,
            memoVersionId: JOB_ID,
            docsScoped: 1,
            docsCovered: 1,
            waves: 1,
            model: "opencode-go/glm-5.3-flash",
        });

        // Reads: the scoped version's bytes, nothing else.
        expect(storage.downloadFile).toHaveBeenCalledWith("documents/u1/d1/source.md");
        expect(storage.downloadFile).toHaveBeenCalledTimes(1);

        // One write: the memo document, under the job-id path.
        expect(uploads).toHaveLength(1);
        const { path: uploadPath, bytes: uploadBytes, contentType } = uploads[0];
        expect(uploadPath).toBe(`documents/u1/${JOB_ID}/source.md`);
        expect(contentType).toBe("text/markdown");
        const markdown = Buffer.from(uploadBytes).toString("utf8");
        expect(markdown).toContain("# RLM deep-run memo");
        expect(markdown).toContain(`- Run: ${JOB_ID}`);
        expect(markdown).toContain("1 wave over 1 of 1 in-scope documents");
        // The synthesized body, not the raw findings state, is the memo.
        expect(markdown).toContain("# Memo\nbody");

        // The version row is the job id and carries the uploaded bytes' hash.
        const versionCall = calls.find(
            (call) => call.op === "rpc" && call.table === "create_document_version",
        );
        expect(versionCall?.payload).toMatchObject({
            p_document_id: JOB_ID,
            p_activate: true,
            p_version: {
                id: JOB_ID,
                source: "generated",
                file_type: "md",
                storage_path: uploadPath,
                content_sha256: contentSha256(Buffer.from(uploadBytes)),
            },
        });

        // The row is the job id, project-scoped, and ends ready.
        const docOps = calls
            .filter((call) => call.table === "documents")
            .map((call) => call.op);
        expect(docOps).toEqual(["select", "upsert", "update"]);
        expect(calls.find((call) => call.op === "upsert")?.payload).toMatchObject({
            id: JOB_ID,
            project_id: "p1",
            user_id: "u1",
            org_id: "org-1",
            status: "processing",
        });

        // No second document write, and no storage.cleanup on the happy path.
        expect(calls.some((call) => call.table === "db_jobs")).toBe(false);
        expect(
            calls.filter((call) => call.table === "documents" && call.op === "delete"),
        ).toEqual([]);

        // Waves advertise exactly the sealed sandbox — no pause surface — and
        // the synthesis call is tool-less prose.
        expect(stream.fn).toHaveBeenCalledTimes(2);
        const waveParams = stream.calls[0];
        expect(waveParams.tools).toEqual([RLM_EXECUTE_CODE_TOOL]);
        expect(JSON.stringify(waveParams.tools)).not.toContain("ask_inputs");
        expect(stream.calls[1].tools).toBeUndefined();
        expect(waveParams.conversationId).toBe(`rlm.deep_run:${JOB_ID}`);

        // The sandbox seam: execute_code reaches the injected sandbox service;
        // any other tool name comes back as tool_unavailable.
        const toolResults = await waveParams.runTools!([
            { id: "t1", name: "execute_code", input: { code: "1+1", timeout_ms: 2000 } },
            { id: "t2", name: "ask_inputs", input: {} },
        ]);
        expect(executeCode.fn).toHaveBeenCalledWith({ code: "1+1", timeoutMs: 2000 });
        expect(JSON.parse(toolResults[0].content)).toEqual({
            ok: true,
            output: "42",
            truncated: false,
        });
        expect(JSON.parse(toolResults[1].content)).toEqual({
            ok: false,
            error: "tool_unavailable",
        });
    });

    it("bounds the scope query by max_docs and runs one wave per slice", async () => {
        const docs = ["d1", "d2", "d3", "d4"];
        const { db, calls } = makeFakeDb({
            tables: {
                document_versions: [
                    { data: null },
                    { data: docs.map((doc) => attachRow(doc)) },
                ],
                documents: [
                    { data: docs.map((doc) => docRow(doc)) },
                    { data: null },
                    { data: null },
                ],
            },
            rpc: (_fn, args) => {
                // The handler always sends p_version as a plain object; echo it.
                const version = args.p_version as { id?: string; storage_path?: string };
                return {
                    data: {
                        id: version.id,
                        document_id: args.p_document_id,
                        storage_path: version.storage_path,
                    },
                    error: null,
                };
            },
        });
        const stream = makeStream([
            "## Findings\nfirst wave [d1.md]",
            "## Findings\nsecond wave [d3.md]",
            "# Memo\nbody",
        ]);
        const services = makeServices({ stream: stream.service });

        const result = await handleRlmDeepRun(
            db,
            baseJob({ maxWaves: 2, maxDocs: 4 }),
            services,
        );

        expect(result).toMatchObject({ waves: 2, docsScoped: 4, docsCovered: 4 });
        const listCall = calls.find(
            (call) => call.table === "documents" && call.op === "select",
        );
        expect(listCall?.filters).toContainEqual(["limit", 4]);
        expect(listCall?.filters).toContainEqual(["eq", "project_id", "p1"]);

        // Two waves over two documents each, then the synthesis: the second
        // wave's system prompt carries the first wave's findings forward.
        expect(stream.fn).toHaveBeenCalledTimes(3);
        expect(stream.calls[1].systemPrompt).toContain("first wave [d1.md]");
        expect(stream.calls[1].messages[0].content).toContain("Wave 2 of 2");
        expect(stream.calls[1].messages[0].content).toContain("d3.md");
    });

    it("short-circuits a retry whose memo already persisted", async () => {
        const { db, calls } = makeFakeDb({
            tables: {
                document_versions: [{ data: { id: JOB_ID } }],
                documents: [{ data: null }],
            },
        });
        const stream = makeStream(["should not be called"]);
        const services = makeServices({ stream: stream.service });

        const result = await handleRlmDeepRun(db, baseJob(), services);

        expect(result).toEqual({ outcome: "already_completed", memoDocumentId: JOB_ID });
        expect(stream.fn).not.toHaveBeenCalled();
        expect(storage.downloadFile).not.toHaveBeenCalled();
        expect(uploads).toEqual([]);
        // The status flag is repaired so the retry finishes the first attempt.
        const updateCall = calls.find(
            (call) => call.table === "documents" && call.op === "update",
        );
        expect(updateCall?.payload).toMatchObject({ status: "ready" });
    });

    it("stops on revoked access without reading or writing anything", async () => {
        const { db, calls } = makeFakeDb({});
        const stream = makeStream(["should not be called"]);
        const services = makeServices({
            stream: stream.service,
            checkProject: makeCheckProject({ ok: false }).service,
        });

        const result = await handleRlmDeepRun(db, baseJob(), services);

        expect(result).toEqual({ outcome: "project_not_found" });
        expect(stream.fn).not.toHaveBeenCalled();
        expect(uploads).toEqual([]);
        expect(calls).toEqual([]);
    });

    it("refuses a caller without content.edit", async () => {
        const { db } = makeFakeDb({});
        const stream = makeStream(["should not be called"]);
        const services = makeServices({
            stream: stream.service,
            checkProject: makeCheckProject({ ...ALLOW_ACCESS, projectRole: "viewer" }).service,
        });

        const result = await handleRlmDeepRun(db, baseJob(), services);

        expect(result).toEqual({ outcome: "forbidden" });
        expect(stream.fn).not.toHaveBeenCalled();
    });

    it("finishes a malformed payload instead of retrying it", async () => {
        const { db, calls } = makeFakeDb({});

        const result = await handleRlmDeepRun(db, baseJob({ prompt: "" }), makeServices());

        expect(result).toEqual({ outcome: "malformed_payload" });
        expect(calls).toEqual([]);
    });

    it("reports an empty scope without invoking the model", async () => {
        const { db } = makeFakeDb({
            tables: {
                document_versions: [{ data: null }],
                documents: [{ data: [] }],
            },
        });
        const stream = makeStream(["should not be called"]);
        const services = makeServices({ stream: stream.service });

        const result = await handleRlmDeepRun(db, baseJob(), services);

        expect(result).toEqual({ outcome: "no_documents", docsScoped: 0, docsSkipped: 0 });
        expect(stream.fn).not.toHaveBeenCalled();
    });

    it("leaves no partial memo when the synthesis call fails", async () => {
        const { db } = makeFakeDb({
            tables: {
                document_versions: [{ data: null }, { data: [attachRow("d1")] }],
                documents: [{ data: [docRow("d1")] }],
            },
        });
        const stream = vi
            .fn()
            .mockResolvedValueOnce({ fullText: "## Findings\n- x [d1.md]" })
            .mockRejectedValueOnce(new Error("provider down"));
        const services = makeServices({
            stream: stream as unknown as RlmRunServices["stream"],
        });

        await expect(handleRlmDeepRun(db, baseJob(), services)).rejects.toThrow(
            "provider down",
        );
        expect(uploads).toEqual([]);
    });

    it("compensates a failed memo write: deletes the version-less row and queues storage cleanup", async () => {
        const { db, calls } = makeFakeDb({
            tables: {
                document_versions: [
                    { data: null }, // guard
                    { data: [attachRow("d1")] }, // attach
                    { data: null }, // post-failure re-check: version did not persist
                ],
                documents: [
                    { data: [docRow("d1")] }, // scope list
                    { data: null }, // upsert
                    { data: null }, // compensating delete
                ],
                db_jobs: [{ data: { id: "cleanup-job" } }],
            },
            rpc: () => ({ data: null, error: { message: "version insert failed" } }),
        });
        const stream = makeStream([
            "## Findings\n- x [d1.md]",
            "# Memo\nbody",
        ]);
        const services = makeServices({ stream: stream.service });

        await expect(handleRlmDeepRun(db, baseJob(), services)).rejects.toThrow(
            "version insert failed",
        );

        const deleteCall = calls.find(
            (call) => call.table === "documents" && call.op === "delete",
        );
        expect(deleteCall?.filters).toContainEqual(["eq", "id", JOB_ID]);
        expect(deleteCall?.filters).toContainEqual(["is", "current_version_id", null]);

        const cleanupCall = calls.find(
            (call) => call.table === "db_jobs" && call.op === "insert",
        );
        expect(cleanupCall?.payload).toMatchObject({
            kind: "storage.cleanup",
            payload: { keys: [`documents/u1/${JOB_ID}/source.md`] },
        });
    });
});

describe("parseRlmRunBody", () => {
    it("defaults counters, model, and scope, and trims the prompt", () => {
        const parsed = parseRlmRunBody({ project_id: "p1", prompt: "  Analyze  " });
        expect(parsed).toEqual({
            ok: true,
            value: {
                projectId: "p1",
                prompt: "Analyze",
                scope: {},
                model: DEFAULT_RLM_MODEL,
                maxWaves: 3,
                maxDocs: 200,
            },
        });
    });

    it("rejects missing fields, out-of-range counters, and bad scopes", () => {
        expect(parseRlmRunBody(null).ok).toBe(false);
        expect(parseRlmRunBody({ prompt: "x" }).ok).toBe(false);
        expect(parseRlmRunBody({ project_id: "p1" }).ok).toBe(false);
        expect(parseRlmRunBody({ project_id: "p1", prompt: "x".repeat(8_001) }).ok).toBe(false);
        expect(parseRlmRunBody({ project_id: "p1", prompt: "x", max_waves: 0 }).ok).toBe(false);
        expect(parseRlmRunBody({ project_id: "p1", prompt: "x", max_waves: 11 }).ok).toBe(false);
        expect(parseRlmRunBody({ project_id: "p1", prompt: "x", max_docs: 501 }).ok).toBe(false);
        expect(parseRlmRunBody({ project_id: "p1", prompt: "x", scope: [] }).ok).toBe(false);
        expect(
            parseRlmRunBody({ project_id: "p1", prompt: "x", scope: { documentIds: ["a", 3] } }).ok,
        ).toBe(false);
        expect(parseRlmRunBody({ project_id: "p1", prompt: "x", model: "" }).ok).toBe(false);
    });

    it("normalizes a valid scope and resolves the model", () => {
        const parsed = parseRlmRunBody({
            project_id: "p1",
            prompt: "x",
            scope: { folderPath: " Contracts / 2026 ", documentIds: ["d1"] },
            model: "opencode-go/glm-5.3-flash",
            max_docs: 10,
        });
        expect(parsed).toMatchObject({
            ok: true,
            value: {
                scope: { documentIds: ["d1"], folderPath: "Contracts / 2026" },
                model: "opencode-go/glm-5.3-flash",
                maxDocs: 10,
            },
        });
    });
});
