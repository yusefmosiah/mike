// chat branches — implementation behind the module facade.
// Business logic + data-access for the chat module.
//
// These functions are the service layer behind chat.routes.ts. They take an
// explicit Supabase client (`db`) plus request-derived primitives, perform the
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
import { type Db } from "../../lib/supabase";
import type { ChatMessage } from "./engine/types";
import {
    resolveLeaf,
    setLeaf,
    siblingsOf,
    walkActivePath,
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
// Move the caller's leaf to a message of this chat and return the ancestry
// that leaf selects. Read-standing is enough: the write touches only the
// caller's own leaf row, and the shared transcript is unchanged.
export async function setLeafAndPath(
    db: Db,
    args: { chatId: string; userId: string; leafId: string },
): Promise<{ ok: true; leaf: string; path: TreeRow[] } | BranchFailure> {
    const path = await walkActivePath(db, args.chatId, args.leafId);
    if (path.length === 0) {
        return { ok: false, kind: "not_found", detail: "Message not found" };
    }

    try {
        await setLeaf(db, args.chatId, args.userId, args.leafId);
    } catch (error) {
        return { ok: false, kind: "error", error };
    }
    return { ok: true, leaf: args.leafId, path };
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
