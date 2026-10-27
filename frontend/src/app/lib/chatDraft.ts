import type { Document } from "@/app/components/shared/types";

/**
 * A composer draft in progress: its text plus whatever was attached. Persisted
 * to localStorage so a draft survives the composer's keyed remount (switching
 * threads, the chat getting its first id) and an app close, force-close
 * included — every change is written synchronously.
 */

export interface ChatDraft {
    text: string;
    docs: Document[];
    workflow: { id: string; title: string } | null;
}

const PREFIX = "mike.composerDraft.v1:";
const INDEX_KEY = "mike.composerDraft.v1:index";
/** Oldest drafts past the cap are dropped; a stale draft still beats none. */
const MAX_DRAFTS = 100;
/**
 * The storage scope for one composer's draft: the account, the surface (a
 * project or the standalone assistant), and the composer's own `chatKey` —
 * so a draft never leaks across accounts or projects, and the project pane's
 * `composerResetKey` intentionally starts a fresh draft.
 */
export function chatDraftKey({
    userId,
    projectId,
    chatKey,
}: {
    userId: string;
    projectId?: string | null;
    chatKey: string;
}): string {
    return [
        encodeURIComponent(userId),
        projectId ? `project:${encodeURIComponent(projectId)}` : "global",
        encodeURIComponent(chatKey),
    ].join(":");
}

function storageKey(key: string): string {
    return `${PREFIX}${key}`;
}

function readIndex(): string[] {
    try {
        const raw = localStorage.getItem(INDEX_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((k): k is string => typeof k === "string")
            : [];
    } catch {
        return [];
    }
}

function writeIndex(keys: string[]) {
    try {
        localStorage.setItem(INDEX_KEY, JSON.stringify(keys));
    } catch {
        // Full storage: drafts degrade to unsaved, nothing else breaks.
    }
}

/** Most-recently-used bookkeeping; drops drafts past MAX_DRAFTS. */
function touch(key: string) {
    const keys = [key, ...readIndex().filter((k) => k !== key)];
    const dropped = keys.splice(MAX_DRAFTS);
    dropped.forEach((k) => {
        try {
            localStorage.removeItem(storageKey(k));
        } catch {
            /* ignore */
        }
    });
    writeIndex(keys);
}

function untouch(key: string) {
    writeIndex(readIndex().filter((k) => k !== key));
}

export function readChatDraft(key: string): ChatDraft | null {
    if (typeof localStorage === "undefined") return null;
    try {
        const raw = localStorage.getItem(storageKey(key));
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        const draft = parsed as Partial<ChatDraft>;
        return {
            text: typeof draft.text === "string" ? draft.text : "",
            docs: Array.isArray(draft.docs) ? draft.docs : [],
            workflow:
                draft.workflow && typeof draft.workflow.id === "string"
                    ? { id: draft.workflow.id, title: draft.workflow.title ?? "" }
                    : null,
        };
    } catch {
        return null;
    }
}

/**
 * Saves the draft, or removes it when every field is empty — sending a
 * message empties the composer, which is what drops the stored draft.
 */
export function writeChatDraft(key: string, draft: ChatDraft) {
    if (typeof localStorage === "undefined") return;
    const empty =
        draft.text.length === 0 &&
        draft.docs.length === 0 &&
        draft.workflow === null;
    try {
        if (empty) {
            localStorage.removeItem(storageKey(key));
            untouch(key);
        } else {
            localStorage.setItem(storageKey(key), JSON.stringify(draft));
            touch(key);
        }
    } catch {
        // Quota or private mode: the draft stays in memory for this mount.
    }
}
