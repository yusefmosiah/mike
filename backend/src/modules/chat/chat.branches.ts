// chat branches — implementation behind the module facade.
// Business logic + data-access for the chat module.
//
// These functions are the service layer behind chat.routes.ts. They take an
// explicit database client (`db`) plus request-derived primitives, perform the
// chat orchestration / DB work, and RETURN values or typed error results. They
// never touch req/res — the thin route handlers map the results onto HTTP
// status codes, headers, and response bodies.
//
// A chat is a tree: every message names the message it answers
// (`parent_message_id`), and every reader has a leaf pointer into it
// (`chat_leaf_state`). Editing a message or stepping between versions never
// rewrites a row — the row is a fact about what happened — it inserts a
// sibling and moves only the caller's own leaf, so nobody else's view of the
// thread changes. The tree primitives themselves (leaf resolution, ancestry
// walking, sibling groups) live in chat.tree.ts.
import { randomUUID } from "node:crypto";
import { forkChatLineage } from "../../lib/llm";
import { safeError } from "../../lib/safeError";
import { type Db } from "../../lib/db";
import { createChat } from "./chat.crud";
import type { ChatMessage } from "./engine/types";
import {
    chatRows,
    newestLeafUnder,
    resolveLeaf,
    setLeaf,
    siblingsOf,
    walkActivePath,
    walkPathFromRows,
    type TreeRow,
} from "./chat.tree";

const PREVIEW_CHARS = 120;

// Same uuid shape the route layer already validates chat cursors with.
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `value` is a uuid the chat routes address rows by. */
export function isMessageId(value: unknown): value is string {
    return typeof value === "string" && UUID_PATTERN.test(value);
}

export type SiblingNavItem = {
    id: string;
    role: string;
    created_at: string;
    preview: string;
};

export type BranchFailure =
    | { ok: false; kind: "not_found"; detail: string }
    | { ok: false; kind: "validation"; detail: string }
    | { ok: false; kind: "error"; error: unknown };

// One line of text for a sibling list. User content is a string; assistant
// content is a stored event list, where the visible prose lives in the
// `content` events — the same partition the client renders.
function textPreview(content: unknown): string {
    let text = "";
    if (typeof content === "string") {
        text = content;
    } else if (Array.isArray(content)) {
        text = content
            .map((event) => {
                if (!event || typeof event !== "object") return "";
                if (!("type" in event) || event.type !== "content") return "";
                return "text" in event && typeof event.text === "string"
                    ? event.text
                    : "";
            })
            .join("");
    }
    return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
}

// POST /chat/:chatId/branches
// Edit-and-branch: the edited message becomes a NEW sibling of the message it
// was edited from (same parent), authored by the caller; the source row is
// never rewritten. The caller's leaf follows the new message, so their view
// moves while every other reader keeps theirs. Omitted fields reuse the
// source row's — content, files and workflow alike.
export async function createBranch(
    db: Db,
    args: {
        chatId: string;
        userId: string;
        fromMessageId: string;
        content?: string | null;
        files?: ChatMessage["files"];
        workflow?: ChatMessage["workflow"];
    },
): Promise<
    | { ok: true; newMessageId: string; path: TreeRow[] }
    | BranchFailure
> {
    // siblingsOf resolves the message inside its sibling group, so one read
    // yields both the source row and the assertion that it is this chat's.
    const group = await siblingsOf(db, args.chatId, args.fromMessageId);
    const source = group.find((row) => row.id === args.fromMessageId);
    if (!source) {
        return { ok: false, kind: "not_found", detail: "Message not found" };
    }
    if (source.role !== "user") {
        return {
            ok: false,
            kind: "validation",
            detail: "from_message_id must reference a user message",
        };
    }

    const newMessageId = randomUUID();
    const { error } = await db.from("chat_messages").insert({
        id: newMessageId,
        chat_id: args.chatId,
        role: "user",
        content: args.content ?? source.content,
        files: args.files ?? source.files,
        workflow: args.workflow ?? source.workflow,
        author_user_id: args.userId,
        parent_message_id: source.parent_message_id,
    });
    if (error) return { ok: false, kind: "error", error };

    try {
        await setLeaf(db, args.chatId, args.userId, newMessageId);
    } catch (error) {
        return { ok: false, kind: "error", error };
    }

    const path = await walkActivePath(db, args.chatId, newMessageId);
    return { ok: true, newMessageId, path };
}

// POST /chat/:chatId/leaf
// Open a message of this chat: the caller's leaf moves to the newest message
// under it (the message itself when nothing answers it), so stepping to a
// prompt version shows that version's answers. Read-standing is enough: the
// write touches only the caller's own leaf row, and the shared transcript is
// unchanged.
export async function setLeafAndPath(
    db: Db,
    args: { chatId: string; userId: string; leafId: string },
): Promise<{ ok: true; leaf: string; path: TreeRow[] } | BranchFailure> {
    const rows = await chatRows(db, args.chatId);
    if (!rows.some((row) => row.id === args.leafId)) {
        return { ok: false, kind: "not_found", detail: "Message not found" };
    }
    const leaf = newestLeafUnder(rows, args.leafId);
    const path = walkPathFromRows(rows, leaf);

    try {
        await setLeaf(db, args.chatId, args.userId, leaf);
    } catch (error) {
        return { ok: false, kind: "error", error };
    }
    return { ok: true, leaf, path };
}

// GET /chat/:chatId/branches/:messageId/siblings
// The message and the versions sharing its parent (oldest first), with cheap
// text previews and the message's 1-based position — enough for a "‹ 2/3 ›"
// navigator without shipping whole messages.
export async function siblingNav(
    db: Db,
    args: { chatId: string; messageId: string },
): Promise<
    | { ok: true; siblings: SiblingNavItem[]; index: number; total: number }
    | BranchFailure
> {
    const siblings = await siblingsOf(db, args.chatId, args.messageId);
    const position = siblings.findIndex((row) => row.id === args.messageId);
    if (position === -1) {
        return { ok: false, kind: "not_found", detail: "Message not found" };
    }

    return {
        ok: true,
        siblings: siblings.map((row) => ({
            id: row.id,
            role: row.role,
            created_at: row.created_at,
            preview: textPreview(row.content),
        })),
        index: position + 1,
        total: siblings.length,
    };
}

// GET /chat/:chatId/path?leaf=
// The ancestry the caller is reading: an explicit leaf, else their stored
// leaf, else the newest message. The same rows the transcript read walks, so
// a client renders any of them with one mapping.
export async function chatPath(
    db: Db,
    args: { chatId: string; userId: string; leaf?: string | null },
): Promise<
    { ok: true; leaf: string | null; path: TreeRow[] } | BranchFailure
> {
    if (args.leaf) {
        const path = await walkActivePath(db, args.chatId, args.leaf);
        if (path.length === 0) {
            return { ok: false, kind: "not_found", detail: "Message not found" };
        }
        return { ok: true, leaf: args.leaf, path };
    }

    // resolveLeaf is the stored leaf when the caller has one, else the newest
    // message; it fails open, so a leaf-state outage degrades to the default
    // branch instead of failing the read.
    const leaf = await resolveLeaf(db, args.chatId, args.userId);
    const path = await walkActivePath(db, args.chatId, leaf);
    return { ok: true, leaf: path.length > 0 ? leaf : null, path };
}

// POST /chat/:chatId/fork
// Branch into a new thread: a new chat whose history is this chat's path up to
// and including one answer, so the conversation continues there while this
// chat stays as it was. The copies keep their authors and timestamps (they
// record what was said, and when); the new chat belongs to the caller, in the
// same project. With the Pi runtime the model transcript forks at the same
// point, so the new chat reuses the cached prefix instead of replaying it.
export async function forkChat(
    db: Db,
    args: {
        chatId: string;
        userId: string;
        userEmail: string | undefined;
        projectId: string | null;
        title: string | null;
        atMessageId: string;
    },
): Promise<
    | { ok: true; chatId: string; leaf: string }
    | BranchFailure
    | { ok: false; kind: "access"; status: number; detail: string }
> {
    const rows = await chatRows(db, args.chatId);
    const path = walkPathFromRows(rows, args.atMessageId);
    const at = path.at(-1);
    if (!at || at.id !== args.atMessageId) {
        return { ok: false, kind: "not_found", detail: "Message not found" };
    }
    if (at.role !== "assistant") {
        return {
            ok: false,
            kind: "validation",
            detail: "message_id must reference an answer",
        };
    }

    const { data: full, error: loadError } = await db
        .from("chat_messages")
        .select("id, role, content, files, workflow, citations, author_user_id, created_at")
        .eq("chat_id", args.chatId)
        .in("id", path.map((row) => row.id));
    if (loadError) return { ok: false, kind: "error", error: loadError };
    const byId = new Map(
        ((full ?? []) as Array<Record<string, unknown> & { id: string }>).map((row) => [row.id, row]),
    );

    const created = await createChat(db, {
        userId: args.userId,
        userEmail: args.userEmail,
        projectId: args.projectId,
    });
    if (!created.ok) return created;

    const newIds = new Map(path.map((row) => [row.id, randomUUID()]));
    const copies = path.map((row, index) => {
        const source: Record<string, unknown> = byId.get(row.id) ?? {};
        return {
            id: newIds.get(row.id),
            chat_id: created.id,
            role: row.role,
            content: source.content ?? row.content,
            files: source.files ?? row.files,
            workflow: source.workflow ?? row.workflow,
            citations: source.citations ?? null,
            author_user_id: source.author_user_id ?? null,
            parent_message_id: index === 0 ? null : newIds.get(path[index - 1].id),
            created_at: row.created_at,
        };
    });
    const { error: insertError } = await db.from("chat_messages").insert(copies);
    if (!insertError && args.title) {
        await db.from("chats").update({ title: args.title }).eq("id", created.id);
    }
    if (insertError) {
        // No half-copied chat left behind for the caller to find.
        await db.from("chats").delete().eq("id", created.id);
        return { ok: false, kind: "error", error: insertError };
    }

    const leaf = newIds.get(at.id) as string;
    try {
        await setLeaf(db, created.id, args.userId, leaf);
    } catch (error) {
        console.error("[chat/fork] failed to set leaf", safeError(error));
    }
    // Bookkeeping: without it the new chat's first turn rebuilds its model
    // transcript from the copied history, which is correct, just uncached.
    await forkChatLineage({
        fromChatId: args.chatId,
        toChatId: created.id,
        atMessageId: at.id,
        messageIds: Object.fromEntries(newIds),
    }).catch((error: unknown) => {
        console.error("[chat/fork] failed to fork the model transcript", safeError(error));
    });
    return { ok: true, chatId: created.id, leaf };
}
