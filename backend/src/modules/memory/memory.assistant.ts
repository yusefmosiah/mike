// The assistant's own edits to memory, made from inside a conversation with
// the edit_memory tool. Each edit is a targeted replacement against the file
// as it is now, written through the same compare-and-swap as every other
// writer, and kept as a version of its own (source "assistant") naming the
// conversation it came from.
//
// The caller decides which files this conversation may write (app memory
// only in the person's private conversation, project memory only with
// `content.edit`); write_memory_file re-checks the conversation's privacy and
// project under its locks.

import {
    ensureMemoryFile,
    findMemoryVersionAt,
    getMemoryCurrent,
    MEMORY_MAX_BYTES,
    MemoryDisabledError,
    MemoryRevisionConflictError,
    MemoryScopeIneligibleError,
    MemoryValidationError,
    writeMemoryFile,
    type MemorySurface,
} from "../../lib/memory/files";
import type { Db } from "../../lib/db";

export type MemoryEdit = { old_text: string; new_text: string };

const MAX_EDITS = 20;
const SUMMARY_MAX_CHARS = 500;

/** Apply `edits` in order; an empty `old_text` appends `new_text`. */
export function applyMemoryEdits(
    content: string,
    edits: MemoryEdit[],
): { ok: true; content: string } | { ok: false; error: string } {
    let next = content;
    for (const [index, edit] of edits.entries()) {
        const label = edits.length > 1 ? `Edit ${index + 1}: ` : "";
        if (edit.old_text === "") {
            if (!edit.new_text.trim()) {
                return { ok: false, error: `${label}there is nothing to add.` };
            }
            const body = next.replace(/\s+$/, "");
            next = body ? `${body}\n${edit.new_text}` : edit.new_text;
            continue;
        }
        const first = next.indexOf(edit.old_text);
        if (first < 0) {
            return {
                ok: false,
                error: `${label}old_text does not appear in the memory file. Call read_memory and quote the text exactly as it is now.`,
            };
        }
        if (next.indexOf(edit.old_text, first + 1) >= 0) {
            return {
                ok: false,
                error: `${label}old_text appears more than once in the memory file. Include enough surrounding text to match one place.`,
            };
        }
        next =
            next.slice(0, first) +
            edit.new_text +
            next.slice(first + edit.old_text.length);
    }
    return { ok: true, content: next };
}

/** The tool's arguments, checked; a message for the model when they are not usable. */
export function parseMemoryEditArgs(
    args: Record<string, unknown>,
):
    | { ok: true; scope: "app" | "project"; edits: MemoryEdit[]; summary: string }
    | { ok: false; error: string } {
    const scope = args.scope;
    if (scope !== "app" && scope !== "project") {
        return { ok: false, error: 'scope must be "app" or "project".' };
    }
    const raw = args.edits;
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, error: "edits must list at least one edit." };
    }
    if (raw.length > MAX_EDITS) {
        return { ok: false, error: `Make at most ${MAX_EDITS} edits in one call.` };
    }
    const edits: MemoryEdit[] = [];
    for (const item of raw) {
        const edit = item as Record<string, unknown> | null;
        if (
            !edit ||
            typeof edit.old_text !== "string" ||
            typeof edit.new_text !== "string"
        ) {
            return {
                ok: false,
                error: "Each edit needs old_text and new_text strings.",
            };
        }
        edits.push({ old_text: edit.old_text, new_text: edit.new_text });
    }
    const summary =
        typeof args.summary === "string" ? args.summary.trim() : "";
    if (!summary) {
        return { ok: false, error: "summary must say what changed and why." };
    }
    return {
        ok: true,
        scope,
        edits,
        summary: summary.slice(0, SUMMARY_MAX_CHARS),
    };
}

export type MemoryEditTarget = {
    userId: string;
    /** The person's private conversation: app memory is theirs to change. */
    appWritable: boolean;
    /** The project whose memory this person may edit here, if any. */
    projectId: string | null;
    surface: MemorySurface;
    conversationId: string;
    /**
     * Set for the background memory review: its edits are the curator's,
     * fenced to the job that scheduled it, and stop the moment the
     * conversation resumes or memory is reset (those errors are thrown).
     */
    curator?: {
        stateId: string;
        generation: number;
        conversationGeneration: number;
        sourceEpoch: number;
        /** Each file's epoch when the job was scheduled. */
        appEpoch: number | null;
        projectEpoch: number | null;
    };
};

export type MemoryEditOutcome =
    | {
          ok: true;
          scope: "app" | "project";
          projectId: string | null;
          versionId: string | null;
          versionNumber: number | null;
          summary: string;
          changed: boolean;
      }
    | { ok: false; error: string };

/**
 * Edit one memory file on the assistant's behalf. A write that loses a race
 * with another writer is retried once against the newer text, so the edits
 * land on what is there now or fail with a reason the model can act on.
 */
export async function editMemoryFromConversation(
    db: Db,
    target: MemoryEditTarget,
    args: Record<string, unknown>,
): Promise<MemoryEditOutcome> {
    const parsed = parseMemoryEditArgs(args);
    if (!parsed.ok) return parsed;
    const { scope, edits, summary } = parsed;
    if (scope === "app" && !target.appWritable) {
        return {
            ok: false,
            error: "App memory cannot be changed from this conversation: other people can see it.",
        };
    }
    if (scope === "project" && !target.projectId) {
        return {
            ok: false,
            error: "There is no project memory this conversation can change.",
        };
    }
    const fileScope = scope === "app" ? "user" : "project";
    const ownerId = scope === "app" ? target.userId : target.projectId!;
    const file = await ensureMemoryFile(db, fileScope, ownerId);

    for (let attempt = 0; attempt < 2; attempt += 1) {
        const { current } = await getMemoryCurrent(db, fileScope, ownerId);
        if (!current.enabled) {
            return { ok: false, error: memoryOffMessage(scope) };
        }
        const applied = applyMemoryEdits(current.content, edits);
        if (!applied.ok) return applied;
        if (Buffer.byteLength(applied.content, "utf8") > MEMORY_MAX_BYTES) {
            return {
                ok: false,
                error: `The memory file would be longer than its ${MEMORY_MAX_BYTES / 1024} KiB limit. Shorten or remove older entries in the same call.`,
            };
        }
        try {
            const curator = target.curator;
            const written = await writeMemoryFile({
                db,
                file,
                content: applied.content,
                expectedRevision: current.revision,
                source: curator ? "curator" : "assistant",
                updatedBy: target.userId,
                changeSummary: summary,
                sourceSurface: target.surface,
                sourceChatId: target.conversationId,
                ...(curator
                    ? {
                          consolidationStateId: curator.stateId,
                          consolidationGeneration: curator.generation,
                          conversationGeneration: curator.conversationGeneration,
                          sourceEpoch: curator.sourceEpoch,
                          expectedEpoch:
                              scope === "app" ? curator.appEpoch : curator.projectEpoch,
                      }
                    : {}),
            });
            const version = written.applied
                ? await findMemoryVersionAt(db, file, written.revision)
                : null;
            return {
                ok: true,
                scope,
                projectId: scope === "project" ? target.projectId : null,
                versionId: version?.id ?? null,
                versionNumber: version?.version_number ?? null,
                summary,
                changed: written.applied,
            };
        } catch (error) {
            if (error instanceof MemoryRevisionConflictError && attempt === 0) {
                continue;
            }
            if (error instanceof MemoryRevisionConflictError) {
                return {
                    ok: false,
                    error: "The memory file changed while you were editing it. Call read_memory and try again.",
                };
            }
            if (error instanceof MemoryDisabledError) {
                return { ok: false, error: memoryOffMessage(scope) };
            }
            if (error instanceof MemoryScopeIneligibleError) {
                return {
                    ok: false,
                    error: "This conversation may not change that memory.",
                };
            }
            if (error instanceof MemoryValidationError) {
                return {
                    ok: false,
                    error: "The edited memory is not valid Markdown for memory.md (raw HTML and control characters are not allowed).",
                };
            }
            throw error;
        }
    }
    return { ok: false, error: "The memory file could not be changed." };
}

function memoryOffMessage(scope: "app" | "project"): string {
    return scope === "app"
        ? "App memory is turned off. The person can turn it on in Settings > Memory."
        : "Project memory is turned off for this project.";
}
