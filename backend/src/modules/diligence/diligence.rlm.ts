// Diligence module: RLM (recursive language model) deep runs.
//
// A deep run is an unattended, project-scoped research pass over the project's
// own documents. Its shape is deliberate, and three invariants hold by
// construction:
//
//   * Unattended — the coordinator is offered exactly one tool, the sealed
//     sandbox `execute_code`. There is no ask/pause surface in the toolset, so
//     the run can never stall waiting for a human; it finishes or it fails.
//   * Copy-on-write — it reads document bytes and writes exactly ONE new
//     document, the cited memo, through the documents facade. No existing
//     document, version, or file is modified.
//   * Zero egress — the only outbound calls are LLM completions over excerpts
//     the run assembles itself; `execute_code` is sealed (no network, no
//     filesystem, no environment).
//
// The corpus is read in bounded waves: each wave's prompt carries a
// character-budgeted excerpt of its slice of the scoped documents, and the
// coordinator returns the complete updated findings state (not a diff), so the
// context for the next wave — and for the final synthesis — stays bounded by
// the last reply rather than by the corpus size.
//
// Job semantics follow lib/dbq: handlers run at-least-once and must be
// idempotent. The memo document id and its single version id are both the JOB
// id, so a retry after partial work lands on the same rows; an attempt whose
// memo already persisted short-circuits before any model call.

import {
    checkProjectAccess,
    type ProjectAccess,
} from "../../lib/access";
import type { Db, DbJob } from "../../lib/dbq/types";
import { enqueueStorageCleanup } from "../../lib/dbq/enqueue";
import { attachActiveVersionPaths, contentSha256 } from "../../lib/documentVersions";
import { isSpreadsheetDocumentType } from "../../lib/documentTypes";
import { extractDocxBodyText } from "../../lib/docxTrackedChanges";
import { extractPresentationText } from "../../lib/officeText";
import { extractLegacyOfficeText, extractPdfText } from "../../lib/pdfText";
import { spreadsheetToLLMText } from "../../lib/spreadsheet";
import { storageKey, downloadFile, uploadFile } from "../../lib/storage";
import { can } from "../../lib/permissions";
import { assertModelAllowed } from "../../lib/privateMode";
import { resolveModel } from "../../lib/llm/models";
import {
    streamChatWithTools,
    type NormalizedToolCall,
    type NormalizedToolResult,
    type OpenAIToolSchema,
} from "../../lib/llm";
import { createDocumentVersion } from "../documents/documents.service";
// The sandbox lives in the shared kernel; importing its file directly keeps
// this module from depending on the sandbox index's re-export surface.
import { executeCode } from "../../lib/sandbox/executeCode";

export const RLM_DEEP_RUN_KIND = "rlm.deep_run";
export const DEFAULT_RLM_MODEL = "opencode-go/glm-5.3-flash";

export const RLM_DEFAULT_MAX_WAVES = 3;
export const RLM_MAX_WAVES = 10;
export const RLM_DEFAULT_MAX_DOCS = 200;
export const RLM_MAX_DOCS = 500;
export const RLM_PROMPT_MAX_CHARS = 8_000;

/** Per-document excerpt ceiling inside a wave prompt. */
const MAX_DOC_CHARS = 24_000;
/** Total excerpt budget for one wave prompt. */
const MAX_WAVE_CHARS = 120_000;
/** Floor for the adaptive per-document slice, so a wide wave still skims all. */
const MIN_EXCERPT_CHARS = 1_500;
/** Ceiling on the findings state handed forward and to the synthesis. */
const MAX_FINDINGS_CHARS = 120_000;
/** Bounded tool rounds for a wave; the coordinator only computes, never edits. */
const WAVE_TOOL_ITERATIONS = 6;
/** Stored memos are Markdown; the read path below handles the type natively. */
const MEMO_FILE_TYPE = "md";
/** document_versions_source_check allows 'generated' — this content is. */
const MEMO_SOURCE = "generated";

export type RlmScope = {
    documentIds?: string[];
    folderPath?: string;
};

export type RlmPayload = {
    projectId: string;
    userId: string;
    prompt: string;
    model: string;
    scope: RlmScope;
    maxWaves: number;
    maxDocs: number;
};

export type RlmExecuteCodeOutcome =
    | { ok: true; output: string; truncated: boolean }
    | { ok: false; error: string };

export type RlmRunServices = {
    stream: typeof streamChatWithTools;
    executeCode: (args: {
        code: string;
        timeoutMs?: number;
        maxOutputChars?: number;
    }) => Promise<RlmExecuteCodeOutcome>;
    checkProject: (
        projectId: string,
        userId: string,
        userEmail: string | null | undefined,
        db: Db,
    ) => Promise<ProjectAccess>;
};

const DEFAULT_SERVICES: RlmRunServices = {
    stream: streamChatWithTools,
    executeCode,
    checkProject: checkProjectAccess,
};

/**
 * The one tool a deep run may call. It computes and returns console output;
 * it cannot read storage, write state, or reach the network. Kept local to
 * this module because the chat tool surface (which this job deliberately does
 * not import) owns the interactive variant of the same capability.
 */
export const RLM_EXECUTE_CODE_TOOL: OpenAIToolSchema = {
    type: "function",
    function: {
        name: "execute_code",
        description:
            "Run a self-contained JavaScript program for exact computation: financial math, table transforms, unit conversions, date arithmetic, parsing or validating the supplied excerpts. The sandbox has no network, no filesystem, and no environment access; it only computes and returns console output (truncated). Call it whenever a number must be exact instead of estimated.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                code: {
                    type: "string",
                    description:
                        "JavaScript source to evaluate. Use console.log to return values.",
                },
                timeout_ms: {
                    type: "integer",
                    minimum: 1000,
                    maximum: 30000,
                    description:
                        "Wall-clock budget in milliseconds (default 5000, maximum 30000).",
                },
            },
            required: ["code"],
        },
    },
};

function clampedInt(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
): number {
    const numeric =
        typeof value === "number"
            ? value
            : typeof value === "string" && value.trim()
              ? Number(value)
              : NaN;
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function trimmedString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/** Normalize "Contracts / 2026" and "Contracts/2026" to one display path. */
function normalizeFolderPath(value: string): string {
    return value
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join(" / ");
}

/**
 * Read the job payload into the validated shape the run needs; null when a
 * required field is missing. Out-of-range counters are clamped, not rejected:
 * a job row already queued should do the bounded work it can, and the service
 * rejects out-of-range values before enqueueing.
 */
export function parseRlmPayload(job: DbJob): RlmPayload | null {
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const projectId = trimmedString(payload.projectId);
    const userId = trimmedString(payload.userId);
    const prompt = trimmedString(payload.prompt);
    if (!projectId || !userId || !prompt) return null;

    const rawScope =
        payload.scope && typeof payload.scope === "object" && !Array.isArray(payload.scope)
            ? (payload.scope as Record<string, unknown>)
            : {};
    const documentIds = Array.isArray(rawScope.documentIds)
        ? rawScope.documentIds
              .map((id) => trimmedString(id))
              .filter(Boolean)
              .slice(0, RLM_MAX_DOCS)
        : [];
    const folderPath = trimmedString(rawScope.folderPath);
    const scope: RlmScope = {};
    if (documentIds.length > 0) scope.documentIds = documentIds;
    if (folderPath) scope.folderPath = folderPath;

    return {
        projectId,
        userId,
        prompt: prompt.slice(0, RLM_PROMPT_MAX_CHARS),
        model: resolveModel(trimmedString(payload.model) || null, DEFAULT_RLM_MODEL),
        scope,
        maxWaves: clampedInt(payload.maxWaves, RLM_DEFAULT_MAX_WAVES, 1, RLM_MAX_WAVES),
        maxDocs: clampedInt(payload.maxDocs, RLM_DEFAULT_MAX_DOCS, 1, RLM_MAX_DOCS),
    };
}

type ScopeDocument = {
    id: string;
    current_version_id?: string | null;
    folder_id?: string | null;
    filename?: string | null;
    file_type?: string | null;
    storage_path?: string | null;
};

/** Deterministic per-job stamp: job.created_at, so retries agree on a name. */
function memoFilename(prompt: string, createdAt: string): string {
    const stamp = (createdAt || new Date().toISOString())
        .slice(0, 16)
        .replace("T", " ");
    const slug = prompt
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60)
        .replace(/[^\w \-]/g, "")
        .trim();
    return `RLM memo ${stamp}${slug ? ` - ${slug}` : ""}.md`;
}

function textFromRawBytes(raw: ArrayBuffer): string {
    const bytes = Buffer.from(raw);
    // A NUL in the head means binary content we cannot read as text; return
    // nothing rather than mojibake into the prompt.
    if (bytes.subarray(0, 1024).includes(0)) return "";
    return bytes.toString("utf8");
}

/**
 * Extract plain text for one stored version, dispatching on file type with
 * the same readers the chat read path uses (lib extraction helpers only — the
 * chat engine's own dispatcher is internal to its module). Markdown/plain
 * files — including memos a previous run wrote — decode as UTF-8. Extraction
 * failure is an empty excerpt, never a failed run.
 */
async function loadDocumentText(
    doc: ScopeDocument,
    maxChars: number,
): Promise<string> {
    if (!doc.storage_path) return "";
    const raw = await downloadFile(doc.storage_path);
    if (!raw) return "";
    const fileType = (doc.file_type ?? "").toLowerCase();
    let text = "";
    try {
        if (fileType === "pdf") {
            text = await extractPdfText(raw);
        } else if (fileType === "docx") {
            text = await extractDocxBodyText(Buffer.from(raw));
            if (!text) {
                // Static import would load this heavy, rarely-needed fallback
                // at worker boot; the chat read path defers it the same way.
                const mammoth = await import("mammoth");
                const result = await mammoth.extractRawText({
                    buffer: Buffer.from(raw),
                });
                text = result.value;
            }
        } else if (isSpreadsheetDocumentType(fileType)) {
            text = spreadsheetToLLMText(Buffer.from(raw));
        } else if (fileType === "pptx") {
            text = await extractPresentationText(Buffer.from(raw));
        } else if (fileType === "doc" || fileType === "ppt") {
            text = await extractLegacyOfficeText(raw);
        } else {
            text = textFromRawBytes(raw);
        }
    } catch {
        text = "";
    }
    if (text.length > maxChars) {
        return `${text.slice(0, maxChars)}\n\n[excerpt truncated]`;
    }
    return text;
}

/** Folder ids whose full path equals the target folder or sits under it. */
async function resolveFolderIds(
    db: Db,
    projectId: string,
    folderPath: string,
): Promise<string[]> {
    const { data } = await db
        .from("project_subfolders")
        .select("id, name, parent_folder_id")
        .eq("project_id", projectId);
    const rows = (data ?? []) as {
        id: string;
        name: string;
        parent_folder_id: string | null;
    }[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const pathOf = (folderId: string): string => {
        const parts: string[] = [];
        let current: string | null = folderId;
        while (current) {
            const row = byId.get(current);
            if (!row) break;
            parts.unshift(row.name);
            current = row.parent_folder_id;
        }
        return parts.join(" / ");
    };
    const target = normalizeFolderPath(folderPath);
    return rows
        .filter((row) => {
            const path = pathOf(row.id);
            return path === target || path.startsWith(`${target} / `);
        })
        .map((row) => row.id);
}

type ScopedDocuments = {
    /** Documents with a readable current version, in stable creation order. */
    docs: ScopeDocument[];
    /** In-scope rows that had no usable version to read. */
    skipped: number;
};

/** Resolve the payload scope to concrete, ready, readable documents. */
async function listScopeDocuments(
    db: Db,
    payload: RlmPayload,
): Promise<ScopedDocuments> {
    const { projectId, maxDocs } = payload;
    const columns = "id, current_version_id, folder_id";

    if (payload.scope.documentIds?.length) {
        const { data } = await db
            .from("documents")
            .select(columns)
            .eq("project_id", projectId)
            .eq("status", "ready")
            .in("id", payload.scope.documentIds)
            .order("created_at", { ascending: true })
            .limit(maxDocs);
        const docs = (data ?? []) as ScopeDocument[];
        await attachActiveVersionPaths(db, docs);
        const readable = docs.filter((doc) => !!doc.storage_path);
        return { docs: readable, skipped: docs.length - readable.length };
    }

    let queryFolderIds: string[] | null = null;
    if (payload.scope.folderPath) {
        queryFolderIds = await resolveFolderIds(db, projectId, payload.scope.folderPath);
        if (queryFolderIds.length === 0) return { docs: [], skipped: 0 };
    }

    let query = db
        .from("documents")
        .select(columns)
        .eq("project_id", projectId)
        .eq("status", "ready");
    if (queryFolderIds) query = query.in("folder_id", queryFolderIds);
    const { data } = await query
        .order("created_at", { ascending: true })
        .limit(maxDocs);
    const docs = (data ?? []) as ScopeDocument[];
    await attachActiveVersionPaths(db, docs);
    const readable = docs.filter((doc) => !!doc.storage_path);
    return { docs: readable, skipped: docs.length - readable.length };
}

function coordinatorSystemPrompt(prompt: string, priorFindings: string): string {
    const sections = [
        "You are the coordinator of an unattended deep-research run over a closed corpus of project documents. The corpus arrives in bounded waves as numbered excerpts.",
        [
            "Rules:",
            "- Work only from the supplied excerpts; never rely on outside knowledge for a factual claim.",
            "- Cite every material fact, figure, date, obligation, or risk with the source filename in brackets, e.g. [Q3-report.xlsx].",
            "- Never invent facts, figures, filenames, or citations. Write 'not addressed in the reviewed documents' when the corpus is silent.",
            "- You may call execute_code for exact arithmetic or text reshaping; it has no network or file access.",
            "- End every reply with the complete updated findings state under a '## Findings' heading — the full state, not a diff — because that reply is the only memory carried into the next wave.",
        ].join("\n"),
        `# Original request\n${prompt}`,
    ];
    if (priorFindings) {
        sections.push(
            `# Findings state from the previous wave\n${priorFindings}`,
        );
    }
    return sections.join("\n\n");
}

function synthesisSystemPrompt(): string {
    return [
        "You are finalizing an unattended deep-research run. The complete findings state from the run is supplied below; the run's tool rounds are over and no additional documents can be read.",
        "Write the final memo in Markdown for the person who requested the run:",
        "- Open with a short title line, then the requested analysis.",
        "- Attribute every material fact, figure, date, obligation, or risk to its source filename in brackets, e.g. [loan-agreement.pdf]. Carry over only citations that appear in the findings state.",
        "- Never invent facts, figures, filenames, or citations. Where the corpus is silent or a wave omitted documents, say so plainly.",
        "- Close with a '## Sources' list of the filenames actually cited, and a short '## Coverage' note stating how many documents were in scope and how many were read.",
    ].join("\n");
}

async function runExecuteCodeCalls(
    calls: NormalizedToolCall[],
    services: RlmRunServices,
): Promise<NormalizedToolResult[]> {
    const results: NormalizedToolResult[] = [];
    for (const call of calls) {
        if (call.name !== RLM_EXECUTE_CODE_TOOL.function.name) {
            results.push({
                tool_use_id: call.id,
                content: JSON.stringify({ ok: false, error: "tool_unavailable" }),
            });
            continue;
        }
        const input = call.input ?? {};
        const code = typeof input.code === "string" ? input.code : "";
        if (!code.trim()) {
            results.push({
                tool_use_id: call.id,
                content: JSON.stringify({
                    ok: false,
                    error: "execute_code requires a non-empty code string",
                }),
            });
            continue;
        }
        const timeoutMs =
            typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms)
                ? Math.min(30_000, Math.max(1_000, Math.floor(input.timeout_ms)))
                : undefined;
        try {
            const outcome = await services.executeCode(
                timeoutMs ? { code, timeoutMs } : { code },
            );
            results.push({
                tool_use_id: call.id,
                content: JSON.stringify(outcome),
            });
        } catch {
            // A throwing runTools callback would abort the whole stream; the
            // model gets the failure as a tool result instead.
            results.push({
                tool_use_id: call.id,
                content: JSON.stringify({ ok: false, error: "execute_code failed" }),
            });
        }
    }
    return results;
}

type WaveOutcome = {
    findings: string;
    docsCovered: number;
    waves: number;
};

/**
 * Read the scoped documents in bounded waves, one model call per wave. Each
 * wave's documents share a per-wave budget: every document in the wave gets
 * an adaptive slice (up to MAX_DOC_CHARS), and if even the floor would
 * overflow the wave budget the tail is left out of the prompt and reported as
 * omitted rather than silently dropped.
 */
async function runWaves(
    services: RlmRunServices,
    payload: RlmPayload,
    jobId: string,
    docs: ScopeDocument[],
): Promise<WaveOutcome> {
    const waveSize = Math.max(1, Math.ceil(docs.length / payload.maxWaves));
    const waveCount = Math.ceil(docs.length / waveSize);
    const covered = new Set<string>();
    let findings = "";

    for (let wave = 0; wave < waveCount; wave++) {
        const slice = docs.slice(wave * waveSize, (wave + 1) * waveSize);
        const perDoc = Math.max(
            MIN_EXCERPT_CHARS,
            Math.min(MAX_DOC_CHARS, Math.floor(MAX_WAVE_CHARS / slice.length)),
        );
        const excerpts: string[] = [];
        let budget = MAX_WAVE_CHARS;
        for (const doc of slice) {
            const text = await loadDocumentText(doc, perDoc);
            const block = `### Document: ${doc.filename ?? "Untitled document"}\n(document_id: ${doc.id}; file_type: ${doc.file_type ?? "unknown"})\n\n${text || "[no extractable text]"}\n`;
            if (block.length > budget) break;
            budget -= block.length;
            excerpts.push(block);
            covered.add(doc.id);
        }
        const omitted = slice.length - excerpts.length;

        const parts = [
            `Wave ${wave + 1} of ${waveCount}. Documents in this wave: ${excerpts.length} of ${slice.length}.`,
        ];
        if (omitted > 0) {
            parts.push(
                `${omitted} document(s) were omitted from this wave to respect the prompt budget; note the omission in your findings.`,
            );
        }
        parts.push("", excerpts.join("\n"));

        const { fullText } = await services.stream({
            model: payload.model,
            systemPrompt: coordinatorSystemPrompt(payload.prompt, findings),
            messages: [{ role: "user", content: parts.join("\n") }],
            // The only advertised tool is the sealed sandbox: no ask/pause
            // tool exists in this set, so the run cannot wait on a human.
            tools: [RLM_EXECUTE_CODE_TOOL],
            runTools: (calls) => runExecuteCodeCalls(calls, services),
            maxIterations: WAVE_TOOL_ITERATIONS,
            conversationId: `rlm.deep_run:${jobId}`,
        });
        const nextFindings = fullText.trim();
        if (nextFindings) {
            findings =
                nextFindings.length <= MAX_FINDINGS_CHARS
                    ? nextFindings
                    : nextFindings.slice(nextFindings.length - MAX_FINDINGS_CHARS);
        }
    }

    return { findings, docsCovered: covered.size, waves: waveCount };
}

function buildMemoMarkdown(args: {
    body: string;
    jobId: string;
    model: string;
    generatedAt: string;
    docsScoped: number;
    docsCovered: number;
    docsSkipped: number;
    waves: number;
}): string {
    const coverage = [
        `- Generated: ${args.generatedAt}`,
        `- Run: ${args.jobId} (${args.waves} wave${args.waves === 1 ? "" : "s"} over ${args.docsCovered} of ${args.docsScoped} in-scope documents)`,
        `- Model: ${args.model}`,
    ];
    if (args.docsSkipped > 0) {
        coverage.push(`- Skipped: ${args.docsSkipped} document(s) had no readable version`);
    }
    return [
        "# RLM deep-run memo",
        "",
        ...coverage,
        "",
        "---",
        "",
        args.body,
        "",
    ].join("\n");
}

/**
 * Persist the memo as one new project document. The ids are the job id, which
 * is what makes a retry idempotent: the documents row is upserted, and the
 * version RPC returns the existing row for an already-written version instead
 * of mutating it. Any bytes this attempt uploaded but the version does not
 * reference, and a row this attempt created that never got a version, are
 * compensated (durable storage cleanup for the object, delete for the row)
 * before the error is rethrown so the job can retry.
 */
async function persistMemo(
    db: Db,
    args: {
        jobId: string;
        projectId: string;
        userId: string;
        orgId: string | null;
        filename: string;
        markdown: string;
    },
): Promise<{ documentId: string; versionId: string }> {
    const bytes = Buffer.from(args.markdown, "utf8");
    const documentId = args.jobId;
    const versionId = args.jobId;
    const storagePath = storageKey(args.userId, documentId, args.filename);

    await uploadFile(
        storagePath,
        bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        "text/markdown",
    );
    try {
        const { error: rowError } = await db.from("documents").upsert(
            {
                id: documentId,
                project_id: args.projectId,
                user_id: args.userId,
                org_id: args.orgId,
                status: "processing",
                library_kind: "file",
            },
            { onConflict: "id" },
        );
        if (rowError) throw rowError;

        const { data: version, error: versionError } = await createDocumentVersion(
            db,
            {
                id: versionId,
                document_id: documentId,
                storage_path: storagePath,
                source: MEMO_SOURCE,
                filename: args.filename,
                file_type: MEMO_FILE_TYPE,
                size_bytes: bytes.byteLength,
                content_sha256: contentSha256(bytes),
            },
            { activate: true },
        );
        if (versionError) throw versionError;
        if (!version) throw new Error("rlm memo version insert returned no data");

        if (version.storage_path !== storagePath) {
            // The RPC found a version this job already wrote (a retry whose
            // predecessor got this far). Our fresh bytes are unreferenced.
            await enqueueStorageCleanup(db, [storagePath]);
        }

        const { error: readyError } = await db
            .from("documents")
            .update({ status: "ready", updated_at: new Date().toISOString() })
            .eq("id", documentId);
        if (readyError) throw readyError;

        return { documentId, versionId };
    } catch (error) {
        // If the version row persisted, its bytes are referenced: keep both
        // and let a retry repair only the status flag. Otherwise roll back
        // what this attempt created — the version-less row and the object.
        const { data: persisted } = await db
            .from("document_versions")
            .select("id")
            .eq("id", versionId)
            .maybeSingle();
        if (!persisted?.id) {
            await db
                .from("documents")
                .delete()
                .eq("id", documentId)
                .is("current_version_id", null);
            await enqueueStorageCleanup(db, [storagePath]);
        }
        throw error;
    }
}

async function actorEmail(db: Db, userId: string): Promise<string | null> {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error) throw new Error("RLM run could not resolve the acting user");
    return data.user?.email?.trim().toLowerCase() ?? null;
}

/**
 * One rlm.deep_run job. Returns the coverage summary, which the runner
 * persists into db_jobs.result for the status endpoint; terminal refusals
 * (malformed payload, revoked access, empty scope) return an outcome instead
 * of throwing so they are not retried.
 */
export async function handleRlmDeepRun(
    db: Db,
    job: DbJob,
    services: RlmRunServices = DEFAULT_SERVICES,
): Promise<Record<string, unknown>> {
    const payload = parseRlmPayload(job);
    if (!payload) return { outcome: "malformed_payload" };

    // Strict private mode must refuse a hosted lane before any bytes move.
    assertModelAllowed(payload.model);

    const userEmail = await actorEmail(db, payload.userId);
    const access = await services.checkProject(
        payload.projectId,
        payload.userId,
        userEmail,
        db,
    );
    if (!access.ok) return { outcome: "project_not_found" };
    if (!can(access.projectRole, "content.edit")) {
        return { outcome: "forbidden" };
    }
    const orgId = access.project.org_id ?? null;

    // Idempotency guard: a retry whose predecessor already persisted the memo
    // must not run the model again (the version id IS the job id).
    const { data: priorVersion } = await db
        .from("document_versions")
        .select("id")
        .eq("id", job.id)
        .is("deleted_at", null)
        .maybeSingle();
    if (priorVersion?.id) {
        // The version write and activation are one transaction, but the
        // document's status update is not; restore it so a retry finishes
        // exactly what the first attempt started.
        await db
            .from("documents")
            .update({ status: "ready", updated_at: new Date().toISOString() })
            .eq("id", job.id);
        return { outcome: "already_completed", memoDocumentId: job.id };
    }

    const scoped = await listScopeDocuments(db, payload);
    const docsScoped = scoped.docs.length + scoped.skipped;
    if (scoped.docs.length === 0) {
        return {
            outcome: "no_documents",
            docsScoped,
            docsSkipped: scoped.skipped,
        };
    }

    const { findings, docsCovered, waves } = await runWaves(
        services,
        payload,
        job.id,
        scoped.docs,
    );
    if (!findings.trim()) {
        return {
            outcome: "no_findings",
            docsScoped,
            docsCovered,
            waves,
        };
    }

    // Synthesis: prose only, no tools — all computation happened in the
    // waves, and a tool round here could truncate the memo itself.
    const synthesis = await services.stream({
        model: payload.model,
        systemPrompt: synthesisSystemPrompt(),
        messages: [
            {
                role: "user",
                content: `# Original request\n${payload.prompt}\n\n# Findings state (${docsCovered} documents across ${waves} wave${waves === 1 ? "" : "s"})\n${findings}\n\nWrite the final memo now.`,
            },
        ],
        conversationId: `rlm.deep_run:${job.id}`,
    });
    const body = synthesis.fullText.trim();
    if (!body) {
        return { outcome: "empty_memo", docsScoped, docsCovered, waves };
    }

    const filename = memoFilename(payload.prompt, job.created_at);
    const markdown = buildMemoMarkdown({
        body,
        jobId: job.id,
        model: payload.model,
        generatedAt: new Date().toISOString(),
        docsScoped,
        docsCovered,
        docsSkipped: scoped.skipped,
        waves,
    });
    const { documentId, versionId } = await persistMemo(db, {
        jobId: job.id,
        projectId: payload.projectId,
        userId: payload.userId,
        orgId,
        filename,
        markdown,
    });

    return {
        outcome: "completed",
        memoDocumentId: documentId,
        memoVersionId: versionId,
        memoFilename: filename,
        docsScoped,
        docsCovered,
        docsSkipped: scoped.skipped,
        waves,
        model: payload.model,
    };
}
