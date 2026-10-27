import type {
    Document,
    Message,
    MessageFile,
} from "@/app/components/shared/types";

/**
 * Messages written while a turn was running, waiting their own turn. Persisted
 * to localStorage per composer scope, exactly like a draft
 * (`chatDraft.ts`), so closing the app mid-queue keeps every entry and each
 * chat's queue never leaks into another account, project, or chat.
 */
export type ChatQueueEffort = NonNullable<Message["reasoning"]>;

export type ChatQueuePauseReason = "stopped" | "failed" | "branch";

export interface ChatQueuePause {
    reason: ChatQueuePauseReason;
    at: number;
}

export interface ChatQueueEntry {
    id: string;
    text: string;
    /** Finished uploads; attachments are uploaded when queued, not sent. */
    docs: Document[];
    workflow: { id: string; title: string } | null;
    /** Stamped at queue time: later model changes do not affect this entry. */
    model: string | null;
    effort: ChatQueueEffort | null;
    stampedAt: number;
    /** `/nr`: joins the thread without asking for a reply. */
    noResponse?: boolean;
    status: "queued" | "sending";
}

export interface ChatQueueState {
    entries: ChatQueueEntry[];
    paused: ChatQueuePause | null;
}

/** What the composer hands the queue when Enter is pressed mid-turn. */
export interface ChatQueueDraft {
    text: string;
    docs: Document[];
    workflow: { id: string; title: string } | null;
    model: string | null;
    effort: ChatQueueEffort | null;
    noResponse?: boolean;
}

const PREFIX = "mike.composerQueue.v1:";
const INDEX_KEY = "mike.composerQueue.v1:index";
/** Oldest queues past the cap are dropped, as drafts are. */
const MAX_QUEUES = 100;

/**
 * The storage scope for one composer's queue: account, surface (project or
 * standalone assistant), and chat key. Matches `chatDraftKey`'s shape so a
 * queue and its draft belong to the same composer.
 */
export function chatQueueKey({
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
        // Full storage: the queue stays in memory for this mount.
    }
}

function touch(key: string) {
    const keys = [key, ...readIndex().filter((k) => k !== key)];
    const dropped = keys.splice(MAX_QUEUES);
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

function isEffort(value: unknown): value is ChatQueueEffort {
    return (
        value === "none" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh" ||
        value === "max"
    );
}

function readEntry(value: unknown): ChatQueueEntry | null {
    if (!value || typeof value !== "object") return null;
    const entry = value as Partial<ChatQueueEntry>;
    if (typeof entry.id !== "string" || typeof entry.text !== "string") {
        return null;
    }
    return {
        id: entry.id,
        text: entry.text,
        docs: Array.isArray(entry.docs) ? entry.docs : [],
        workflow:
            entry.workflow && typeof entry.workflow.id === "string"
                ? {
                      id: entry.workflow.id,
                      title:
                          typeof entry.workflow.title === "string"
                              ? entry.workflow.title
                              : "",
                  }
                : null,
        model: typeof entry.model === "string" ? entry.model : null,
        effort: isEffort(entry.effort) ? entry.effort : null,
        stampedAt:
            typeof entry.stampedAt === "number" ? entry.stampedAt : Date.now(),
        ...(entry.noResponse === true ? { noResponse: true } : {}),
        // A reload never resumes a half-sent entry; it is still in the queue.
        status: "queued",
    };
}

function readPause(value: unknown): ChatQueuePause | null {
    if (!value || typeof value !== "object") return null;
    const pause = value as Partial<ChatQueuePause>;
    if (
        pause.reason !== "stopped" &&
        pause.reason !== "failed" &&
        pause.reason !== "branch"
    ) {
        return null;
    }
    return {
        reason: pause.reason,
        at: typeof pause.at === "number" ? pause.at : Date.now(),
    };
}

export const EMPTY_CHAT_QUEUE: ChatQueueState = { entries: [], paused: null };

export function readChatQueue(key: string): ChatQueueState {
    if (typeof window === "undefined") return EMPTY_CHAT_QUEUE;
    try {
        const raw = localStorage.getItem(storageKey(key));
        if (!raw) return EMPTY_CHAT_QUEUE;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return EMPTY_CHAT_QUEUE;
        const state = parsed as Partial<ChatQueueState>;
        const entries = Array.isArray(state.entries)
            ? state.entries.flatMap((entry) => {
                  const parsedEntry = readEntry(entry);
                  return parsedEntry ? [parsedEntry] : [];
              })
            : [];
        return {
            entries,
            paused: entries.length > 0 ? readPause(state.paused) : null,
        };
    } catch {
        return EMPTY_CHAT_QUEUE;
    }
}

/**
 * Writes the queue, or removes it when no entries remain — the same
 * empty-means-gone rule as drafts.
 */
export function writeChatQueue(key: string, state: ChatQueueState) {
    if (typeof window === "undefined") return;
    // Paused with nothing left to review is not a queue.
    const next: ChatQueueState = {
        entries: state.entries,
        paused: state.entries.length > 0 ? state.paused : null,
    };
    try {
        if (next.entries.length === 0) {
            localStorage.removeItem(storageKey(key));
            untouch(key);
        } else {
            localStorage.setItem(storageKey(key), JSON.stringify(next));
            touch(key);
        }
    } catch {
        // Quota or private mode: the queue stays in memory for this mount.
    }
}

export function newChatQueueEntry(draft: ChatQueueDraft): ChatQueueEntry {
    return {
        id: crypto.randomUUID(),
        text: draft.text,
        docs: draft.docs,
        workflow: draft.workflow,
        model: draft.model,
        effort: draft.effort,
        stampedAt: Date.now(),
        ...(draft.noResponse ? { noResponse: true } : {}),
        status: "queued",
    };
}

/** Appends a written message. A paused queue stays paused until reviewed. */
export function enqueueChatQueue(
    key: string,
    draft: ChatQueueDraft,
): ChatQueueState {
    const current = readChatQueue(key);
    const next: ChatQueueState = {
        entries: [...current.entries, newChatQueueEntry(draft)],
        paused: current.paused,
    };
    writeChatQueue(key, next);
    return next;
}

/** Moves an entry one place; the ends clamp instead of wrapping. */
export function reorderChatQueue(
    key: string,
    id: string,
    direction: -1 | 1,
): ChatQueueState {
    const current = readChatQueue(key);
    const index = current.entries.findIndex((entry) => entry.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.entries.length) {
        return current;
    }
    const entries = [...current.entries];
    const [moved] = entries.splice(index, 1);
    entries.splice(target, 0, moved);
    const next = { ...current, entries };
    writeChatQueue(key, next);
    return next;
}

export function removeChatQueueEntry(
    key: string,
    id: string,
): ChatQueueState {
    const current = readChatQueue(key);
    const next = {
        ...current,
        entries: current.entries.filter((entry) => entry.id !== id),
    };
    writeChatQueue(key, next);
    return next;
}

export function clearChatQueue(key: string): ChatQueueState {
    writeChatQueue(key, EMPTY_CHAT_QUEUE);
    return EMPTY_CHAT_QUEUE;
}

export function markChatQueuePaused(
    key: string,
    reason: ChatQueuePauseReason,
): ChatQueueState {
    const current = readChatQueue(key);
    if (current.entries.length === 0) return current;
    if (current.paused?.reason === reason) return current;
    const next = { ...current, paused: { reason, at: Date.now() } };
    writeChatQueue(key, next);
    return next;
}

export function resumeChatQueue(key: string): ChatQueueState {
    const current = readChatQueue(key);
    if (!current.paused) return current;
    const next = { ...current, paused: null };
    writeChatQueue(key, next);
    return next;
}

/**
 * Moves a queue written before a new chat had its id onto the id it adopted.
 * Only used for the `new-chat` composer scope; normal thread switches never
 * move entries between chats.
 */
export function adoptChatQueue(
    fromKey: string,
    toKey: string,
): ChatQueueState {
    const from = readChatQueue(fromKey);
    const to = readChatQueue(toKey);
    if (from.entries.length === 0 || to.entries.length > 0) return to;
    writeChatQueue(toKey, from);
    clearChatQueue(fromKey);
    return from;
}

/** The message a queued entry sends: its own stamp, not today's settings. */
export function queuedMessage(entry: ChatQueueEntry): Message {
    const files: MessageFile[] = entry.docs.map((document) => ({
        filename: document.filename,
        document_id: document.id,
        ...(document.current_version_id
            ? { version_id: document.current_version_id }
            : {}),
        ...(document.active_version_number != null
            ? { version_number: document.active_version_number }
            : {}),
    }));
    return {
        role: "user",
        content: entry.text,
        ...(files.length > 0 ? { files } : {}),
        ...(entry.workflow ? { workflow: entry.workflow } : {}),
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.effort ? { reasoning: entry.effort } : {}),
        ...(entry.noResponse ? { noResponse: true } : {}),
    };
}
