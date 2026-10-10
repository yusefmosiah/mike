// Citation checks as verifier tasks (goals/mission-6-citation-verification-subagents.md).
//
// A check is a verification_tasks row and a queued job, not part of the turn
// that wrote the citations: the task names the producing invocation (the
// assistant message) and refuses to run inside it. Each passage is one step;
// after each step the verdict, its snapshot and the task's checkpoint are
// stored, so a worker that dies mid-run resumes where it stopped, a step limit
// bounds the run, and a cancellation is honoured between steps. Reads re-check
// the asking person's authority at run time (citations.sources.ts).
import type { Db } from "../../lib/db";
import type { DbJob } from "../../lib/dbq/types";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { currentTurnHolder } from "../../lib/turnClaims";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getAccessibleChat } from "../chat/chat.service";
import { createSourceReader, type WebFetch } from "./citations.sources";
import {
    citationQuotes,
    gradeQuote,
    sha256,
    type BlockOffset,
    type CitationQuote,
    type SnapshotInput,
    type Verdict,
} from "./citations.verifier";

export const CITATION_CHECK_JOB = "citations.verify";
/** verification_tasks.step_limit's default: one step per quoted passage. */
const DEFAULT_STEP_LIMIT = 100;

export type VerificationTask = {
    id: string;
    chat_id: string;
    message_id: string;
    producer_invocation_id: string;
    actor_user_id: string | null;
    project_id: string | null;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    step_limit: number;
    steps_used: number;
    checkpoint: { next?: number };
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
    quote_index: number;
    source_kind: string;
    quote: string;
    verdict: Verdict;
    reason: string | null;
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
 * Queue a check of one assistant message's citations. `invokedBy` is the
 * invocation asking (a turn calling this as a tool passes its own message
 * id): an invocation may not grade what it produced, and neither may anyone
 * while the producing turn is still running.
 */
export async function startCitationCheck(
    db: Db,
    args: Actor & { chatId: string; messageId: string; invokedBy?: string | null; stepLimit?: number },
): Promise<ServiceResult<VerificationTask>> {
    const access = await getAccessibleChat(db, { chatId: args.chatId, userId: args.userId, userEmail: args.userEmail });
    if (!access.ok) return failure("not_found", "Chat not found");

    const { data: message } = await db
        .from("chat_messages")
        .select("id, chat_id, role, citations")
        .eq("id", args.messageId)
        .eq("chat_id", args.chatId)
        .maybeSingle();
    if (!message || message.role !== "assistant") return failure("not_found", "Message not found");

    if (args.invokedBy && args.invokedBy === args.messageId) {
        return failure("conflict", "A response cannot check its own citations.", "self_grading");
    }
    const holder = await currentTurnHolder(db, "chat", args.chatId);
    if (holder?.turnId === args.messageId) {
        return failure("conflict", "The response is still being written; check it once it finishes.", "producer_running");
    }
    if (citationQuotes(message.citations).length === 0) {
        return failure("validation", "This response has no quoted citations to check.", "no_citations");
    }

    const projectId = (access.chat.project_id as string | null | undefined) ?? null;
    const { data: task, error } = await db
        .from("verification_tasks")
        .insert({
            kind: "citation_check",
            chat_id: args.chatId,
            message_id: args.messageId,
            producer_invocation_id: args.messageId,
            actor_user_id: args.userId,
            project_id: projectId,
            step_limit: args.stepLimit ?? DEFAULT_STEP_LIMIT,
        })
        .select("*")
        .single();
    if (error || !task) return internalFailure(error ?? new Error("task not created"));

    try {
        await enqueueDbJob(db, {
            kind: CITATION_CHECK_JOB,
            payload: { taskId: task.id },
            dedupeKey: `${CITATION_CHECK_JOB}:${task.id}`,
        });
    } catch (queueError) {
        await db.from("verification_tasks").update({ status: "failed", error: "not_queued", finished_at: new Date().toISOString() }).eq("id", task.id);
        return internalFailure(queueError);
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
        })
        .select("id")
        .single();
    if (error || !data) throw error ?? new Error("snapshot not stored");
    return data.id as string;
}

async function finish(db: Db, taskId: string, status: VerificationTask["status"], error: string | null = null) {
    await db
        .from("verification_tasks")
        .update({ status, error, finished_at: new Date().toISOString() })
        .eq("id", taskId);
    return { outcome: status, ...(error ? { error } : {}) };
}

export type RunDeps = {
    fetchWeb?: WebFetch;
    /** Called before each step; a test uses it to stand in for a process dying. */
    beforeStep?: (index: number, quote: CitationQuote) => void | Promise<void>;
};

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

    await db
        .from("verification_tasks")
        .update({ status: "running", started_at: task.started_at ?? new Date().toISOString() })
        .eq("id", task.id);

    const { data: profile } = await db.from("user_profiles").select("email").eq("user_id", task.actor_user_id).maybeSingle();
    const actor = { userId: task.actor_user_id, email: (profile?.email as string | null | undefined) ?? null };
    const access = await getAccessibleChat(db, { chatId: task.chat_id, userId: actor.userId, userEmail: actor.email });
    if (!access.ok) return finish(db, task.id, "failed", "access_revoked");

    const { data: message } = await db.from("chat_messages").select("citations").eq("id", task.message_id).maybeSingle();
    const quotes = citationQuotes(message?.citations);
    const read = createSourceReader({
        db,
        actor,
        taskId: task.id,
        chatId: task.chat_id,
        projectId: task.project_id,
        egress: await egressFor(db, task.project_id),
        fetchWeb: deps.fetchWeb,
    });

    let steps = task.steps_used ?? 0;
    const stepLimit = task.step_limit ?? DEFAULT_STEP_LIMIT;
    for (let index = task.checkpoint?.next ?? 0; index < quotes.length; index += 1) {
        const { data: flags } = await db.from("verification_tasks").select("cancel_requested").eq("id", task.id).maybeSingle();
        if (flags?.cancel_requested) return finish(db, task.id, "cancelled");
        if (steps >= stepLimit) return finish(db, task.id, "failed", "step_limit");

        const quote = quotes[index];
        await deps.beforeStep?.(index, quote);
        const source = await read(quote);
        const grade = gradeQuote(quote.quote, source);
        const snapshotId = source.ok ? await storeSnapshot(db, source.snapshot) : null;
        const { error } = await db.from("citation_checks").upsert(
            {
                task_id: task.id,
                chat_id: task.chat_id,
                message_id: task.message_id,
                citation_ref: quote.citationRef,
                quote_index: quote.quoteIndex,
                source_kind: quote.sourceKind,
                quote: quote.quote,
                verdict: grade.verdict,
                reason: grade.reason,
                snapshot_id: snapshotId,
                block_id: grade.blockId,
                start_char: grade.startChar,
                end_char: grade.endChar,
                excerpt: grade.excerpt,
                checked_at: new Date().toISOString(),
            },
            { onConflict: "task_id,citation_ref,quote_index" },
        );
        if (error) throw error;
        steps += 1;
        await db
            .from("verification_tasks")
            .update({ steps_used: steps, checkpoint: { next: index + 1 } })
            .eq("id", task.id);
    }
    return finish(db, task.id, "completed");
}

/** The queue's entry point (jobs/registry.ts). */
export async function handleCitationCheckJob(db: Db, job: DbJob): Promise<Record<string, unknown>> {
    const taskId = typeof job.payload?.taskId === "string" ? job.payload.taskId : null;
    if (!taskId) return { outcome: "malformed_payload" };
    return runCitationCheck(db, taskId);
}

/** The latest check of a message and its verdicts, for anyone who can read the chat. */
export async function getCitationChecks(
    db: Db,
    args: Actor & { chatId: string; messageId: string },
): Promise<ServiceResult<{ task: VerificationTask | null; checks: CitationCheck[] }>> {
    const access = await getAccessibleChat(db, { chatId: args.chatId, userId: args.userId, userEmail: args.userEmail });
    if (!access.ok) return failure("not_found", "Chat not found");
    const { data: tasks } = await db
        .from("verification_tasks")
        .select("*")
        .eq("chat_id", args.chatId)
        .eq("message_id", args.messageId)
        .order("created_at", { ascending: false })
        .limit(1);
    const task = ((tasks as VerificationTask[] | null) ?? [])[0] ?? null;
    if (!task) return ok({ task: null, checks: [] });
    const { data: checks } = await db
        .from("citation_checks")
        .select("*")
        .eq("task_id", task.id)
        .order("citation_ref", { ascending: true })
        .order("quote_index", { ascending: true });
    return ok({ task, checks: (checks as CitationCheck[] | null) ?? [] });
}

export type Recheck = {
    check_id: string;
    stored_verdict: Verdict;
    /** The verdict regraded from the stored snapshot; null when there is none. */
    verdict: Verdict | null;
    /** The stored text still hashes to the stored digest. */
    hash_ok: boolean | null;
    same: boolean;
    content_sha256: string | null;
};

/**
 * Re-grade a stored verdict from its snapshot alone: no source is read again.
 * The snapshot's text must still hash to its stored digest; a third person
 * who gets the same verdict from the same text has re-checked the citation.
 */
export async function recheckCitation(db: Db, args: Actor & { checkId: string }): Promise<ServiceResult<Recheck>> {
    const { data: check } = await db.from("citation_checks").select("*").eq("id", args.checkId).maybeSingle();
    if (!check) return failure("not_found", "Check not found");
    const access = await getAccessibleChat(db, { chatId: check.chat_id as string, userId: args.userId, userEmail: args.userEmail });
    if (!access.ok) return failure("not_found", "Check not found");
    const stored = check as CitationCheck;
    if (!stored.snapshot_id) {
        return ok({ check_id: stored.id, stored_verdict: stored.verdict, verdict: null, hash_ok: null, same: false, content_sha256: null });
    }
    const { data: snapshot } = await db.from("citation_snapshots").select("*").eq("id", stored.snapshot_id).maybeSingle();
    if (!snapshot) return failure("not_found", "Snapshot not found");
    const content = snapshot.content as string;
    const hashOk = sha256(content) === snapshot.content_sha256;
    const grade = gradeQuote(stored.quote, {
        ok: true,
        snapshot: {
            sourceKind: snapshot.source_kind as SnapshotInput["sourceKind"],
            content,
            blockOffsets: (snapshot.block_offsets as BlockOffset[] | null) ?? null,
        },
    });
    return ok({
        check_id: stored.id,
        stored_verdict: stored.verdict,
        verdict: grade.verdict,
        hash_ok: hashOk,
        same: hashOk && grade.verdict === stored.verdict && grade.blockId === stored.block_id,
        content_sha256: snapshot.content_sha256 as string,
    });
}

/** Ask a queued or running task to stop; it stops before its next step. */
export async function cancelCitationCheck(db: Db, args: Actor & { taskId: string }): Promise<ServiceResult<{ cancelled: boolean }>> {
    const { data: task } = await db.from("verification_tasks").select("id, chat_id, status").eq("id", args.taskId).maybeSingle();
    if (!task) return failure("not_found", "Task not found");
    const access = await getAccessibleChat(db, { chatId: task.chat_id as string, userId: args.userId, userEmail: args.userEmail });
    if (!access.ok) return failure("not_found", "Task not found");
    if (task.status !== "queued" && task.status !== "running") return ok({ cancelled: false });
    await db.from("verification_tasks").update({ cancel_requested: true }).eq("id", task.id);
    return ok({ cancelled: true });
}
