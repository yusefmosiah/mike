// Citation checks of documents as verifier tasks
// (goals/mission-6-citation-verification-subagents.md).
//
// A check protects a document before it goes out: a memo the assistant
// drafted, or an uploaded brief it then edited. It is a verification_tasks
// row naming one document version, run by a worker job (or inline, when the
// assistant asks for it in a turn), by model calls that share nothing with the
// conversation that wrote the document.
//
// Two phases, both durable. First a model lists the document's citations;
// the list is stored on the task's checkpoint, so a restarted worker does not
// list them again. Then each citation is checked in parallel: its source is
// located and stored as a hashed snapshot, any quote is matched against it,
// and a judge decides whether the source supports what the document says.
// Each verdict is a row; a restarted worker checks only those without one.
// Cancellation is honoured between citations; the step limit bounds a run.
import type { Db } from "../../lib/db";
import type { DbJob } from "../../lib/dbq/types";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { completeText } from "../../lib/llm";
import { loadActiveVersion } from "../../lib/documentVersions";
import { documentSuffix } from "../../lib/documentTypes";
import { flashModelsFor, resolveEffectiveChatModel } from "../../lib/modelSelection";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getDocument } from "../documents/documents.service";
import { getUserModelSettings } from "../user/user.service";
import { extractCitations, mapPool, type Complete, type ExtractedCitation } from "./citations.extract";
import { judgeSupport, verdictFor, type Judgement, type Support } from "./citations.judge";
import {
    documentText,
    locateSource,
    type CaseLookup,
    type Candidate,
    type SourceContext,
    type WebFetch,
    type WebSearch,
} from "./citations.sources";
import { matchQuote, sha256, type SnapshotInput, type Verdict } from "./citations.verifier";

export const CITATION_CHECK_JOB = "citations.verify";
/** One step per citation; verification_tasks allows at most 500. */
const DEFAULT_STEP_LIMIT = 300;
const DEFAULT_CONCURRENCY = 6;

export type VerificationTask = {
    id: string;
    kind: "document_citation_check" | "citation_check";
    document_id: string | null;
    document_version_id: string | null;
    invoked_by: string | null;
    model: string | null;
    actor_user_id: string | null;
    project_id: string | null;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    step_limit: number;
    steps_used: number;
    checkpoint: { citations?: ExtractedCitation[] };
    cancel_requested: boolean;
    error: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
};

export type CitationCheck = {
    id: string;
    task_id: string;
    citation_ref: number;
    source_kind: string;
    citation_text: string | null;
    cited_block_id: string | null;
    proposition: string | null;
    quote: string | null;
    quote_found: boolean | null;
    verdict: Verdict;
    support: Support | null;
    reason: string | null;
    support_reason: string | null;
    snapshot_id: string | null;
    block_id: string | null;
    start_char: number | null;
    end_char: number | null;
    excerpt: string | null;
    checked_at: string;
};

type Actor = { userId: string; userEmail: string | null | undefined };

async function egressFor(db: Db, projectId: string | null): Promise<"allow" | "deny"> {
    if (!projectId) return "allow";
    const { data } = await db.from("projects").select("egress_policy").eq("id", projectId).maybeSingle();
    return data?.egress_policy === "deny" ? "deny" : "allow";
}

/**
 * The checker's model. A check makes two model calls per citation, so it runs
 * on the subscription flash models whenever the person can use them (see
 * OPENCODE_FLASH_MODELS), not on the conversation's model, which may be a
 * premium one. CITATION_CHECK_MODEL overrides; without an OpenCode Go key the
 * model asked for (the turn's own model) or the person's last selected model
 * is used, provided they hold a key for it.
 */
async function checkerModel(
    db: Db,
    userId: string,
    requested: string | null | undefined,
): Promise<ServiceResult<string>> {
    const settings = await getUserModelSettings(userId, db);
    const flash = flashModelsFor(settings.api_keys);
    if (!process.env.CITATION_CHECK_MODEL?.trim() && flash.length) return ok(flash[0]);
    const resolved = await resolveEffectiveChatModel({
        requested: process.env.CITATION_CHECK_MODEL?.trim() || requested,
        lastSelectedModel: settings.last_selected_chat_model,
        apiKeys: settings.api_keys,
        userId,
        db,
    });
    if (!resolved.ok) return failure("validation", resolved.detail, resolved.code);
    return ok(resolved.model);
}

/**
 * Create a check of one document version (the current one unless named) for
 * anyone who can read the document. `enqueue: false` leaves running it to
 * the caller (the assistant's tool runs it inside its turn).
 */
export async function startCitationCheck(
    db: Db,
    args: Actor & {
        documentId: string;
        versionId?: string | null;
        model?: string | null;
        invokedBy?: string | null;
        stepLimit?: number;
        enqueue?: boolean;
    },
): Promise<ServiceResult<VerificationTask>> {
    const access = await getDocument(args.documentId, args.userId, args.userEmail ?? undefined, db);
    if (!access.ok) return failure("not_found", "Document not found");
    const version = await loadActiveVersion(args.documentId, db, args.versionId ?? null);
    if (!version) return failure("not_found", "Document version not found");
    const model = await checkerModel(db, args.userId, args.model);
    if (!model.ok) return model;

    const { data: task, error } = await db
        .from("verification_tasks")
        .insert({
            kind: "document_citation_check",
            document_id: args.documentId,
            document_version_id: version.id,
            invoked_by: args.invokedBy ?? null,
            model: model.data,
            actor_user_id: args.userId,
            project_id: (access.doc.project_id as string | null | undefined) ?? null,
            step_limit: args.stepLimit ?? DEFAULT_STEP_LIMIT,
            status: "queued",
            steps_used: 0,
            checkpoint: {},
            cancel_requested: false,
        })
        .select("*")
        .single();
    if (error || !task) return internalFailure(error ?? new Error("task not created"));

    if (args.enqueue !== false) {
        try {
            await enqueueDbJob(db, {
                kind: CITATION_CHECK_JOB,
                payload: { taskId: task.id },
                dedupeKey: `${CITATION_CHECK_JOB}:${task.id}`,
            });
        } catch (queueError) {
            await db
                .from("verification_tasks")
                .update({ status: "failed", error: "not_queued", finished_at: new Date().toISOString() })
                .eq("id", task.id);
            return internalFailure(queueError);
        }
    }
    return ok(task as VerificationTask);
}

/** Store a snapshot once per source and content hash; returns its id. */
async function storeSnapshot(db: Db, snapshot: SnapshotInput): Promise<string> {
    const digest = sha256(snapshot.content);
    let query = db
        .from("citation_snapshots")
        .select("id")
        .eq("source_kind", snapshot.sourceKind)
        .eq("content_sha256", digest);
    query = snapshot.versionId ? query.eq("document_version_id", snapshot.versionId) : query.eq("url", snapshot.url ?? "");
    const { data: existing } = await query.limit(1);
    const found = (existing as Array<{ id: string }> | null)?.[0];
    if (found) return found.id;
    const { data, error } = await db
        .from("citation_snapshots")
        .insert({
            source_kind: snapshot.sourceKind,
            document_id: snapshot.documentId ?? null,
            document_version_id: snapshot.versionId ?? null,
            url: snapshot.url ?? null,
            content: snapshot.content,
            content_sha256: digest,
            block_offsets: snapshot.blockOffsets ?? null,
            retrieved_at: new Date().toISOString(),
        })
        .select("id")
        .single();
    if (error || !data) throw error ?? new Error("snapshot not stored");
    return data.id as string;
}

async function finish(db: Db, taskId: string, status: VerificationTask["status"], error: string | null = null) {
    const { data: rows } = await db.from("citation_checks").select("id").eq("task_id", taskId);
    await db
        .from("verification_tasks")
        .update({
            status,
            error,
            finished_at: new Date().toISOString(),
            steps_used: ((rows as unknown[] | null) ?? []).length,
        })
        .eq("id", taskId);
    return { outcome: status, ...(error ? { error } : {}) };
}

export type RunDeps = {
    complete?: Complete;
    fetchWeb?: WebFetch;
    searchWeb?: WebSearch;
    lookupCase?: CaseLookup;
    concurrency?: number;
    /** Called before each citation; a test uses it to stand in for a process dying. */
    beforeStep?: (citation: ExtractedCitation) => void | Promise<void>;
    /** Called after each verdict is stored (the assistant's tool streams progress). */
    onChecked?: (done: number, total: number) => void;
};

type Outcome = {
    verdict: Verdict;
    reason: string;
    sourceKind: string;
    snapshotId: string | null;
    judgement: Judgement | null;
    quote: ReturnType<typeof matchQuote> | null;
};

/** Locate, snapshot, quote-match and judge one citation. */
async function checkOne(db: Db, ctx: SourceContext, complete: Complete, citation: ExtractedCitation): Promise<Outcome> {
    const fallbackKind = citation.kind === "case" ? "case" : "web";
    const located = await locateSource(ctx, citation);
    if (!located.ok) {
        return { verdict: located.verdict, reason: located.reason, sourceKind: fallbackKind, snapshotId: null, judgement: null, quote: null };
    }
    let chosen: { candidate: Candidate; judgement: Judgement } | null = null;
    for (const candidate of located.candidates) {
        const judgement = await judgeSupport(complete, {
            citation,
            source: candidate.snapshot.content,
            sourceLabel: candidate.label,
        });
        if (!located.searched || judgement.identified) {
            chosen = { candidate, judgement };
            break;
        }
    }
    if (!chosen) {
        return {
            verdict: citation.kind === "case" ? "not-found" : "unverifiable",
            reason:
                citation.kind === "case"
                    ? "No such case was found in CourtListener, and no web search result was this case."
                    : "A web search did not find this source.",
            sourceKind: fallbackKind,
            snapshotId: null,
            judgement: null,
            quote: null,
        };
    }
    const { candidate, judgement } = chosen;
    const quote = citation.quote ? matchQuote(candidate.snapshot.content, citation.quote) : null;
    const verdict = verdictFor({ quoteFound: quote ? quote.found : null, judgement });
    const reason =
        quote && !quote.found && verdict !== "contradicted"
            ? `The quoted words are not in the source. ${judgement.reason}`
            : judgement.reason;
    return {
        verdict,
        reason,
        sourceKind: candidate.snapshot.sourceKind,
        snapshotId: await storeSnapshot(db, candidate.snapshot),
        judgement,
        quote,
    };
}

/**
 * The task's model, then the other flash models after it when it is one: each
 * has its own subscription allowance, so a model whose allowance is used up
 * (or that is failing) hands over to the next rather than to a paid one.
 */
function modelLadder(model: string, apiKeys: Parameters<typeof flashModelsFor>[0]): string[] {
    const flash = flashModelsFor(apiKeys);
    const at = flash.indexOf(model);
    return at < 0 ? [model] : [...flash.slice(at), ...flash.slice(0, at)];
}

function fallingOver(models: string[], apiKeys: Parameters<typeof completeText>[0]["apiKeys"]): Complete {
    return async (args) => {
        let lastError: unknown;
        for (const model of models) {
            try {
                return await completeText({ model, ...args, apiKeys });
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError;
    };
}

/** Run (or resume) one task to its end. Safe to call again after a crash. */
export async function runCitationCheck(db: Db, taskId: string, deps: RunDeps = {}): Promise<Record<string, unknown>> {
    const { data: row } = await db.from("verification_tasks").select("*").eq("id", taskId).maybeSingle();
    if (!row) return { outcome: "missing_task" };
    const task = row as VerificationTask;
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        return { outcome: task.status };
    }
    if (task.cancel_requested) return finish(db, task.id, "cancelled");
    if (!task.actor_user_id) return finish(db, task.id, "failed", "actor_gone");
    if (task.kind !== "document_citation_check" || !task.document_id || !task.document_version_id) {
        return finish(db, task.id, "failed", "unsupported_task");
    }

    await db
        .from("verification_tasks")
        .update({ status: "running", started_at: task.started_at ?? new Date().toISOString() })
        .eq("id", task.id);

    const { data: profile } = await db.from("user_profiles").select("email").eq("user_id", task.actor_user_id).maybeSingle();
    const actor = { userId: task.actor_user_id, email: (profile?.email as string | null | undefined) ?? null };
    const access = await getDocument(task.document_id, actor.userId, actor.email ?? undefined, db);
    if (!access.ok) return finish(db, task.id, "failed", "access_revoked");

    const settings = deps.complete ? null : await getUserModelSettings(actor.userId, db);
    const complete: Complete = deps.complete ?? fallingOver(modelLadder(task.model ?? "", settings?.api_keys), settings?.api_keys);

    let citations = task.checkpoint?.citations;
    if (!citations) {
        const { data: version } = await db
            .from("document_versions")
            .select("id, storage_path, pdf_storage_path, file_type, filename, deleted_at")
            .eq("id", task.document_version_id)
            .maybeSingle();
        if (!version || version.deleted_at) return finish(db, task.id, "failed", "version_gone");
        const fileType = ((version.file_type as string | null) ?? documentSuffix((version.filename as string | null) ?? ""))
            .toLowerCase()
            .replace(/^\./, "");
        const read = await documentText(db, {
            documentId: task.document_id,
            versionId: task.document_version_id,
            storagePath: version.storage_path as string | null,
            pdfStoragePath: version.pdf_storage_path as string | null,
            fileType,
        });
        if (!read) return finish(db, task.id, "failed", "unreadable_document");
        citations = await extractCitations({ content: read.content, blocks: read.blockOffsets }, complete, {
            concurrency: deps.concurrency,
        });
        await db.from("verification_tasks").update({ checkpoint: { citations } }).eq("id", task.id);
    }

    const { data: doneRows } = await db.from("citation_checks").select("citation_ref").eq("task_id", task.id);
    const done = new Set(((doneRows as Array<{ citation_ref: number }> | null) ?? []).map((r) => r.citation_ref));
    const limit = task.step_limit ?? DEFAULT_STEP_LIMIT;
    const inLimit = citations.slice(0, limit);
    const pending = inLimit.filter((c) => !done.has(c.index));

    const ctx: SourceContext = {
        db,
        actor,
        taskId: task.id,
        projectId: task.project_id,
        documentId: task.document_id,
        egress: await egressFor(db, task.project_id),
        courtlistenerToken: settings?.api_keys?.courtlistener ?? null,
        fetchWeb: deps.fetchWeb,
        searchWeb: deps.searchWeb,
        lookupCase: deps.lookupCase,
    };
    const envConcurrency = Number(process.env.CITATION_CHECK_CONCURRENCY);
    const concurrency = deps.concurrency ?? (envConcurrency > 0 ? envConcurrency : DEFAULT_CONCURRENCY);
    let cancelled = false;
    let checked = done.size;
    await mapPool(pending, concurrency, async (citation) => {
        if (cancelled) return;
        const { data: flags } = await db.from("verification_tasks").select("cancel_requested").eq("id", task.id).maybeSingle();
        if (flags?.cancel_requested) {
            cancelled = true;
            return;
        }
        await deps.beforeStep?.(citation);
        const outcome = await checkOne(db, ctx, complete, citation);
        const { error } = await db.from("citation_checks").upsert(
            {
                task_id: task.id,
                document_id: task.document_id,
                document_version_id: task.document_version_id,
                citation_ref: citation.index,
                quote_index: 0,
                source_kind: outcome.sourceKind,
                citation_text: citation.citation,
                cited_block_id: citation.blockId,
                proposition: citation.proposition,
                quote: citation.quote,
                quote_found: outcome.quote ? outcome.quote.found : null,
                verdict: outcome.verdict,
                support: outcome.judgement?.support ?? null,
                reason: outcome.reason,
                support_reason: outcome.judgement?.reason ?? null,
                snapshot_id: outcome.snapshotId,
                block_id: null,
                start_char: outcome.quote?.startChar ?? null,
                end_char: outcome.quote?.endChar ?? null,
                excerpt: outcome.judgement?.evidence ?? outcome.quote?.excerpt ?? null,
                checked_at: new Date().toISOString(),
            },
            { onConflict: "task_id,citation_ref,quote_index" },
        );
        if (error) throw error;
        checked += 1;
        deps.onChecked?.(checked, inLimit.length);
    });
    if (cancelled) return finish(db, task.id, "cancelled");
    return finish(db, task.id, "completed", citations.length > limit ? "step_limit" : null);
}

/** The queue's entry point (jobs/registry.ts). */
export async function handleCitationCheckJob(db: Db, job: DbJob): Promise<Record<string, unknown>> {
    const taskId = typeof job.payload?.taskId === "string" ? job.payload.taskId : null;
    if (!taskId) return { outcome: "malformed_payload" };
    return runCitationCheck(db, taskId);
}

/**
 * The latest check of a document (of one version, when named) and its
 * verdicts, for anyone who can read the document. `current_version_id` lets a
 * reader see that the document has changed since it was checked.
 */
export async function getCitationChecks(
    db: Db,
    args: Actor & { documentId: string; versionId?: string | null },
): Promise<
    ServiceResult<{ task: VerificationTask | null; checks: CitationCheck[]; current_version_id: string | null }>
> {
    const access = await getDocument(args.documentId, args.userId, args.userEmail ?? undefined, db);
    if (!access.ok) return failure("not_found", "Document not found");
    const currentVersionId = (access.doc.current_version_id as string | null | undefined) ?? null;
    let query = db
        .from("verification_tasks")
        .select("*")
        .eq("kind", "document_citation_check")
        .eq("document_id", args.documentId);
    if (args.versionId) query = query.eq("document_version_id", args.versionId);
    const { data: tasks } = await query.order("created_at", { ascending: false }).limit(1);
    const task = ((tasks as VerificationTask[] | null) ?? [])[0] ?? null;
    if (!task) return ok({ task: null, checks: [], current_version_id: currentVersionId });
    const { data: checks } = await db
        .from("citation_checks")
        .select("*")
        .eq("task_id", task.id)
        .order("citation_ref", { ascending: true });
    return ok({ task, checks: (checks as CitationCheck[] | null) ?? [], current_version_id: currentVersionId });
}

export type Recheck = {
    check_id: string;
    /** The stored text still hashes to the stored digest. */
    hash_ok: boolean | null;
    /** The quote matched against the stored text again; null when nothing is quoted. */
    quote_found: boolean | null;
    same: boolean;
    content_sha256: string | null;
};

/**
 * Re-check a stored verdict from its snapshot alone: no source is read again.
 * The snapshot's text must still hash to its stored digest, and a quoted
 * passage must match it as it did. The judge's reading stays on the row with
 * its excerpt, which is checked to be in the same text.
 */
export async function recheckCitation(db: Db, args: Actor & { checkId: string }): Promise<ServiceResult<Recheck>> {
    const { data: check } = await db.from("citation_checks").select("*").eq("id", args.checkId).maybeSingle();
    if (!check?.document_id) return failure("not_found", "Check not found");
    const access = await getDocument(check.document_id as string, args.userId, args.userEmail ?? undefined, db);
    if (!access.ok) return failure("not_found", "Check not found");
    const stored = check as CitationCheck;
    if (!stored.snapshot_id) {
        return ok({ check_id: stored.id, hash_ok: null, quote_found: null, same: false, content_sha256: null });
    }
    const { data: snapshot } = await db.from("citation_snapshots").select("*").eq("id", stored.snapshot_id).maybeSingle();
    if (!snapshot) return failure("not_found", "Snapshot not found");
    const content = snapshot.content as string;
    const hashOk = sha256(content) === snapshot.content_sha256;
    const quoteFound = stored.quote ? matchQuote(content, stored.quote).found : null;
    const excerptOk = stored.excerpt ? matchQuote(content, stored.excerpt).found : true;
    return ok({
        check_id: stored.id,
        hash_ok: hashOk,
        quote_found: quoteFound,
        same: hashOk && quoteFound === stored.quote_found && excerptOk,
        content_sha256: snapshot.content_sha256 as string,
    });
}

/** Ask a queued or running task to stop; it stops before its next citation. */
export async function cancelCitationCheck(db: Db, args: Actor & { taskId: string }): Promise<ServiceResult<{ cancelled: boolean }>> {
    const { data: task } = await db
        .from("verification_tasks")
        .select("id, document_id, status")
        .eq("id", args.taskId)
        .maybeSingle();
    if (!task?.document_id) return failure("not_found", "Task not found");
    const access = await getDocument(task.document_id as string, args.userId, args.userEmail ?? undefined, db);
    if (!access.ok) return failure("not_found", "Task not found");
    if (task.status !== "queued" && task.status !== "running") return ok({ cancelled: false });
    await db.from("verification_tasks").update({ cancel_requested: true }).eq("id", task.id);
    return ok({ cancelled: true });
}

/** A short account of a finished check for the assistant to relay. */
export async function summarizeCitationCheck(db: Db, taskId: string) {
    const { data: task } = await db.from("verification_tasks").select("status, error").eq("id", taskId).maybeSingle();
    const { data: rows } = await db
        .from("citation_checks")
        .select("citation_ref, citation_text, verdict, reason, proposition, excerpt, cited_block_id")
        .eq("task_id", taskId)
        .order("citation_ref", { ascending: true });
    const checks = (rows as Array<Record<string, unknown>> | null) ?? [];
    const counts: Record<string, number> = {};
    for (const row of checks) counts[row.verdict as string] = (counts[row.verdict as string] ?? 0) + 1;
    return {
        task_id: taskId,
        status: (task?.status as string | undefined) ?? "missing",
        error: (task?.error as string | null | undefined) ?? null,
        citations_checked: checks.length,
        counts,
        flagged: checks
            .filter((row) => row.verdict !== "exists-and-matches")
            .map((row) => ({
                citation: row.citation_text,
                verdict: row.verdict,
                reason: row.reason,
                document_says: row.proposition,
                source_excerpt: row.excerpt,
                block_id: row.cited_block_id,
            })),
    };
}
